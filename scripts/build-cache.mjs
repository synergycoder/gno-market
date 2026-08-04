#!/usr/bin/env node
// Runs the expensive scans (genesis-realm source, full tx-deploy history,
// NFT-standard detection) ONCE per scheduled run instead of once per
// visitor's browser. Publishes a small JSON file per network that the
// static site fetches directly — turns "every visitor pays the slow
// first-load cost" into "one scheduled job pays it every 30 minutes, then
// every visitor gets a fast JSON fetch." See .github/workflows/update-data.yml
// for the schedule, and index.html's loadFromCache()/*Live() fallback split
// for how the client consumes this.
//
// No npm dependencies on purpose — matches the rest of this project's
// "just files, nothing to install" philosophy. Needs Node 18+ (native
// fetch). Re-running this script is safe and cheap: it reads its own
// previous output as a starting cache, same incremental-fetch pattern the
// client used to do itself in localStorage.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const NETWORKS = {
  testnet: {
    label: "topaz-1 (testnet)",
    rpcUrl: "https://rpc.topaz.testnets.gno.land",
    indexerUrl: "https://indexer.topaz.testnets.gno.land/graphql/query",
  },
  betanet: {
    label: "gnoland1 (betanet)",
    rpcUrl: "https://rpc.gno.land",
    indexerUrl: "https://indexer.gno.land/graphql/query",
  },
};

// ---------- low-level chain access (Node port of index.html's abciQuery) ----------

async function abciQuery(rpcUrl, qpath, dataStr, timeoutMs = 15000) {
  const data = Buffer.from(dataStr, "utf-8").toString("base64");
  const url = `${rpcUrl}/abci_query?path=${encodeURIComponent('"' + qpath + '"')}&data=${encodeURIComponent('"' + data + '"')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`RPC timed out after ${timeoutMs / 1000}s (${qpath})`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const raw = json.result.response.ResponseBase.Data;
  if (json.result.response.ResponseBase.Error) return null;
  return raw ? Buffer.from(raw, "base64").toString("utf-8") : "";
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- GRC20 tokens: same regex-over-Render() approach as the client ----------

async function fetchTokens(net) {
  const markdown = (await abciQuery(net.rpcUrl, "vm/qrender", "gno.land/r/demo/defi/grc20reg:")) || "";
  const lineRe = /^- \*\*(.+?)\*\* - \[(.+?)\]\([^)]*\)(?:\.(\S+))? - /gm;
  const rows = [];
  let m;
  while ((m = lineRe.exec(markdown)) !== null) {
    rows.push({ name: m[1], path: m[2], symbol: m[3] || "—" });
  }
  return rows;
}

// ---------- NFT standard detection: identical rules to index.html ----------

const STANDARD_MARKERS = [
  { std: "GRC721", mentionRe: /grc721/i, funcRe: /func\s+(?:\([^)]*\)\s*)?(Mint|OwnerOf|TokenURI|SafeTransferFrom)\s*\(/ },
  { std: "GRC1155", mentionRe: /grc1155/i, funcRe: /func\s+(?:\([^)]*\)\s*)?(Mint|BalanceOf|URI|SafeTransferFrom|SafeBatchTransferFrom)\s*\(/ },
];

function detectStandard(files) {
  const combined = files.map(f => f.body).join("\n");
  for (const marker of STANDARD_MARKERS) {
    if (marker.mentionRe.test(combined) && marker.funcRe.test(combined)) return marker.std;
  }
  return null;
}

function nonTestGnoFiles(files) {
  return (files || []).filter(f => f.name.endsWith(".gno") && !f.name.endsWith("_test.gno"));
}

// ---------- deployed packages via transaction history (incremental) ----------

async function fetchDeployedPackages(net, prevState) {
  const lastHeight = prevState?.lastHeight || 0;
  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        block_height: { gt: ${lastHeight} },
        messages: { route: { eq: "vm" }, typeUrl: { eq: "add_package" } }
      }) {
        block_height
        messages { value { ... on MsgAddPackage { creator package { path files { name body } } } } }
      }
    }`;
  const res = await fetch(net.indexerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);

  const packages = { ...(prevState?.txPackages || {}) };
  let newHeight = lastHeight;
  let newCount = 0;
  for (const tx of json.data.getTransactions || []) {
    for (const msg of tx.messages) {
      const v = msg.value;
      const pkg = v && v.package;
      if (!pkg) continue;
      newCount++;
      const isRealm = pkg.path.startsWith("gno.land/r/");
      packages[pkg.path] = {
        path: pkg.path,
        blockHeight: tx.block_height,
        creator: v.creator,
        standard: isRealm ? detectStandard(nonTestGnoFiles(pkg.files)) : null,
      };
      if (tx.block_height > newHeight) newHeight = tx.block_height;
    }
  }
  return { packages, lastHeight: newHeight, newCount };
}

// ---------- genesis-only realms: same qpaths-diff + qfile scan as the client ----------

async function fetchGenesisStandards(net, allRealms, txPaths, prevGenesis) {
  const genesisOnly = allRealms.filter(p => !txPaths.has(p));
  const known = { ...(prevGenesis || {}) };
  const toFetch = genesisOnly.filter(p => !(p in known));

  if (toFetch.length > 0) {
    await mapLimit(toFetch, 8, async (p) => {
      try {
        const listing = await abciQuery(net.rpcUrl, "vm/qfile", p);
        const filenames = (listing || "").split("\n").map(s => s.trim())
          .filter(n => n.endsWith(".gno") && !n.endsWith("_test.gno"));
        const files = await mapLimit(filenames, 4, async (name) => ({
          name,
          body: (await abciQuery(net.rpcUrl, "vm/qfile", `${p}/${name}`)) || "",
        }));
        known[p] = detectStandard(files);
      } catch {
        known[p] = null; // unreadable, treat as no match rather than retry forever
      }
    });
  }

  return { genesisStandards: known, genesisOnlyCount: genesisOnly.length, newlyFetched: toFetch.length };
}

// ---------- per-network orchestration ----------

async function buildNetwork(netKey, net) {
  console.log(`\n=== ${netKey} (${net.label}) ===`);
  const outPath = path.join(DATA_DIR, `${netKey}.json`);
  let prev = null;
  try {
    prev = JSON.parse(await readFile(outPath, "utf-8"));
  } catch {
    // no previous run, or corrupt — start fresh
  }

  const [tokens, allRealmsRaw, txResult] = await Promise.all([
    fetchTokens(net),
    abciQuery(net.rpcUrl, "vm/qpaths", "gno.land/r/"),
    fetchDeployedPackages(net, prev),
  ]);
  console.log(`tokens: ${tokens.length}`);
  console.log(`tx-deployed packages: ${Object.keys(txResult.packages).length} (${txResult.newCount} new this run)`);

  const allRealms = (allRealmsRaw || "").split("\n").map(s => s.trim()).filter(Boolean);
  const txPaths = new Set(Object.keys(txResult.packages).filter(p => p.startsWith("gno.land/r/")));
  const { genesisStandards, genesisOnlyCount, newlyFetched } =
    await fetchGenesisStandards(net, allRealms, txPaths, prev?.genesisStandards);
  console.log(`genesis-only realms: ${genesisOnlyCount} (${newlyFetched} newly fetched this run)`);

  const nftRealms = [];
  for (const path of allRealms) {
    const std = txPaths.has(path) ? txResult.packages[path].standard : genesisStandards[path];
    if (std) nftRealms.push({ path, standard: std });
  }
  nftRealms.sort((a, b) => a.path.localeCompare(b.path));

  const recentDeployed = Object.values(txResult.packages)
    .map(p => ({
      path: p.path,
      blockHeight: p.blockHeight,
      creator: p.creator,
      kind: p.path.startsWith("gno.land/r/") ? "Realm" : "Package",
    }))
    .sort((a, b) => b.blockHeight - a.blockHeight);

  const output = {
    network: netKey,
    generatedAt: new Date().toISOString(),
    lastHeight: txResult.lastHeight,
    tokens,
    nftRealms,
    recentDeployed,
    genesisStandards,
    txPackages: txResult.packages,
    stats: {
      tokenCount: tokens.length,
      nftRealmCount: nftRealms.length,
      totalRealmsScanned: allRealms.length,
      txPackageCount: Object.keys(txResult.packages).length,
      genesisOnlyCount,
    },
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`wrote ${outPath}`);
}

async function main() {
  for (const [netKey, net] of Object.entries(NETWORKS)) {
    await buildNetwork(netKey, net);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
