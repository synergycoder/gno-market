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

// Same timeout protection as abciQuery, for GraphQL calls. Necessary, not
// paranoid: this exact indexer has been directly observed hanging (never
// responding, no error) during this project's development — a script that
// runs unattended in CI cannot afford an unbounded await on that.
async function graphqlQuery(indexerUrl, query, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`GraphQL query timed out after ${timeoutMs / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
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

// Same "mention + characteristic function" heuristic as NFT detection above,
// applied to two more categories. Independent of the NFT check (a realm
// could in principle match more than one), and reuses whatever source was
// already fetched for the NFT pass — no extra RPC calls.
const GOVERNANCE_MARKERS = [
  { mentionRe: /governance|\bdao\b|\bgov\b/i, funcRe: /func\s+(?:\([^)]*\)\s*)?(Propose|Vote|Execute)\s*\(/ },
];
const SOCIAL_MARKERS = [
  { mentionRe: /board|blog|social/i, funcRe: /func\s+(?:\([^)]*\)\s*)?(CreateThread|CreatePost|CreateReply|CreateBoard|Comment|NewPost)\s*\(/ },
];

function matchesAnyMarker(files, markers) {
  const combined = files.map(f => f.body).join("\n");
  return markers.some(m => m.mentionRe.test(combined) && m.funcRe.test(combined));
}

// Gno's "filetest" format (single file combining setup + expected output)
// lives in files suffixed `_filetest.gno`, not `_test.gno` — realms with
// many of these (boards2/v1 alone has ~190) were being needlessly fetched
// and scanned in full, multiplying RPC calls and the chance of one flaky
// fetch tanking the whole realm's detection (see the per-file try/catch
// below, which is the other half of that fix).
function nonTestGnoFiles(files) {
  return (files || []).filter(f =>
    f.name.endsWith(".gno") && !f.name.endsWith("_test.gno") && !f.name.endsWith("_filetest.gno")
  );
}

// ---------- block times ----------
// Originally one batched query per chunk via the `_or` combinator (no
// "height in [...]" filter exists on this schema). That worked fine
// against testnet's indexer even with 150 conditions, but hung
// indefinitely against betanet's — confirmed by hand with curl: a single
// `{height:{eq:N}}` query resolves in well under a second, the identical
// query wrapped in `_or:[...]` never returns at all. A real difference
// between the two indexer deployments' query-planning, not a fluke.
// Individual queries are slower in aggregate but the only approach proven
// to actually work on both — concurrency-limited to keep it reasonable.

async function fetchBlockTimes(net, heights) {
  const result = new Map();
  await mapLimit(heights, 8, async (h) => {
    try {
      const data = await graphqlQuery(net.indexerUrl, `query { getBlocks(where: { height: { eq: ${h} } }) { height time } }`);
      const b = (data.getBlocks || [])[0];
      if (b) result.set(b.height, b.time);
    } catch {
      // leave this height unresolved rather than failing the whole run —
      // the client just won't show a date for that one row.
    }
  });
  return result;
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
  const data = await graphqlQuery(net.indexerUrl, query, 60000); // can return a lot of file content on first run

  const packages = { ...(prevState?.txPackages || {}) };
  let newHeight = lastHeight;
  let newCount = 0;
  for (const tx of data.getTransactions || []) {
    for (const msg of tx.messages) {
      const v = msg.value;
      const pkg = v && v.package;
      if (!pkg) continue;
      newCount++;
      const isRealm = pkg.path.startsWith("gno.land/r/");
      const files = nonTestGnoFiles(pkg.files);
      packages[pkg.path] = {
        path: pkg.path,
        blockHeight: tx.block_height,
        creator: v.creator,
        standard: isRealm ? detectStandard(files) : null,
        governance: isRealm ? matchesAnyMarker(files, GOVERNANCE_MARKERS) : false,
        social: isRealm ? matchesAnyMarker(files, SOCIAL_MARKERS) : false,
      };
      if (tx.block_height > newHeight) newHeight = tx.block_height;
    }
  }

  // Transaction has no timestamp field on this indexer — only Block does —
  // so resolving "when was this deployed" needs a second query joined by
  // height. Resolves for any package still missing it, not just ones from
  // this run's delta: the first run after this field was added needs to
  // backfill every pre-existing entry once; every run after that, only
  // genuinely new packages lack it. Stored on the package entry itself, so
  // it persists through the same incremental-cache mechanism as everything
  // else and is never re-fetched once resolved.
  const heightsNeedingTime = [...new Set(
    Object.values(packages).filter(p => !p.blockTime).map(p => p.blockHeight)
  )];
  if (heightsNeedingTime.length > 0) {
    const blockTimes = await fetchBlockTimes(net, heightsNeedingTime);
    for (const pkg of Object.values(packages)) {
      if (!pkg.blockTime && blockTimes.has(pkg.blockHeight)) {
        pkg.blockTime = blockTimes.get(pkg.blockHeight);
      }
    }
  }

  return { packages, lastHeight: newHeight, newCount };
}

// ---------- realm call activity (incremental) ----------
// Powers four different views — Trending/active realms, DAO governance,
// Social, and DeFi/Gnoswap — which all just filter/sort the same "which
// realms got MsgCall'd, how often, by whom, and when" dataset differently.
// One shared fetch instead of four separate ones.

async function fetchCallActivity(net, prevState) {
  const lastHeight = prevState?.lastHeight || 0;
  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        block_height: { gt: ${lastHeight} },
        messages: { route: { eq: "vm" }, typeUrl: { eq: "exec" } }
      }) {
        block_height
        messages { value { ... on MsgCall { caller pkg_path func } } }
      }
    }`;
  const data = await graphqlQuery(net.indexerUrl, query, 60000);

  // Re-hydrate from the previous run's plain-JSON shape into working Sets
  // so incremental unique-caller counting stays correct across runs (a
  // caller seen in an earlier run must not be double-counted as "new").
  const byPath = {};
  for (const [p, entry] of Object.entries(prevState?.byPath || {})) {
    byPath[p] = { ...entry, callers: new Set(entry.callers), funcs: { ...entry.funcs } };
  }

  let newHeight = lastHeight;
  let newCount = 0;
  for (const tx of data.getTransactions || []) {
    for (const msg of tx.messages) {
      const v = msg.value;
      if (!v || !v.pkg_path) continue;
      newCount++;
      let agg = byPath[v.pkg_path];
      if (!agg) {
        agg = { calls: 0, callers: new Set(), funcs: {}, firstBlockHeight: tx.block_height, lastBlockHeight: 0 };
        byPath[v.pkg_path] = agg;
      }
      agg.calls++;
      agg.callers.add(v.caller);
      agg.funcs[v.func] = (agg.funcs[v.func] || 0) + 1;
      agg.firstBlockHeight = Math.min(agg.firstBlockHeight, tx.block_height);
      agg.lastBlockHeight = Math.max(agg.lastBlockHeight, tx.block_height);
      if (tx.block_height > newHeight) newHeight = tx.block_height;
    }
  }

  // Same "resolve once, persist forever" block-time backfill pattern as
  // fetchDeployedPackages — only the most recent activity height per realm
  // needs a human-readable date, and past a realm's OWN most recent call
  // this run, it never changes, so it's never re-fetched.
  const heightsNeedingTime = [...new Set(
    Object.values(byPath).filter(a => !a.lastBlockTime).map(a => a.lastBlockHeight)
  )];
  if (heightsNeedingTime.length > 0) {
    const blockTimes = await fetchBlockTimes(net, heightsNeedingTime);
    for (const agg of Object.values(byPath)) {
      if (!agg.lastBlockTime && blockTimes.has(agg.lastBlockHeight)) {
        agg.lastBlockTime = blockTimes.get(agg.lastBlockHeight);
      }
    }
  }

  const serializedByPath = {};
  for (const [p, agg] of Object.entries(byPath)) {
    serializedByPath[p] = {
      calls: agg.calls,
      callers: [...agg.callers], // kept (not just the count) so a future run can re-hydrate the Set for correct incremental uniqueness
      topFunc: Object.entries(agg.funcs).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      firstBlockHeight: agg.firstBlockHeight,
      lastBlockHeight: agg.lastBlockHeight,
      lastBlockTime: agg.lastBlockTime || null,
    };
  }

  return { byPath: serializedByPath, lastHeight: newHeight, newCount };
}

// ---------- genesis-only realms: same qpaths-diff + qfile scan as the client ----------

async function fetchGenesisStandards(net, allRealms, txPaths, prevGenesis) {
  const genesisOnly = allRealms.filter(p => !txPaths.has(p));
  const known = { ...(prevGenesis || {}) };
  // Also re-fetch anything left in the old (pre-governance/social) cache
  // shape, where a path's value was a bare standard string or null instead
  // of {standard, governance, social} — a one-time self-healing migration,
  // cheap since the genesis-only set is small (tens of realms, not hundreds).
  const toFetch = genesisOnly.filter(p => !(p in known) || known[p] === null || typeof known[p] !== "object");

  if (toFetch.length > 0) {
    await mapLimit(toFetch, 8, async (p) => {
      try {
        const listing = await abciQuery(net.rpcUrl, "vm/qfile", p);
        const filenames = (listing || "").split("\n").map(s => s.trim())
          .filter(n => n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"));
        // A realm can have a hundred-plus files (mostly gno "filetest" files,
        // now filtered above, but genuine source files too) — one flaky RPC
        // call among many used to wipe the WHOLE realm's detection result to
        // "no match" via the outer catch. Fail per-file instead: a missing
        // file just means less source to scan, not a false "unreadable".
        const files = await mapLimit(filenames, 4, async (name) => {
          try {
            return { name, body: (await abciQuery(net.rpcUrl, "vm/qfile", `${p}/${name}`)) || "" };
          } catch {
            return { name, body: "" };
          }
        });
        known[p] = {
          standard: detectStandard(files),
          governance: matchesAnyMarker(files, GOVERNANCE_MARKERS),
          social: matchesAnyMarker(files, SOCIAL_MARKERS),
        };
      } catch {
        known[p] = { standard: null, governance: false, social: false }; // unreadable, treat as no match rather than retry forever
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

  const [tokens, allRealmsRaw, txResult, callActivityResult] = await Promise.all([
    fetchTokens(net),
    abciQuery(net.rpcUrl, "vm/qpaths", "gno.land/r/"),
    fetchDeployedPackages(net, prev),
    fetchCallActivity(net, prev?.callActivity),
  ]);
  console.log(`tokens: ${tokens.length}`);
  console.log(`tx-deployed packages: ${Object.keys(txResult.packages).length} (${txResult.newCount} new this run)`);
  console.log(`call activity: ${Object.keys(callActivityResult.byPath).length} realms with calls (${callActivityResult.newCount} new calls this run)`);

  const allRealms = (allRealmsRaw || "").split("\n").map(s => s.trim()).filter(Boolean);
  const txPaths = new Set(Object.keys(txResult.packages).filter(p => p.startsWith("gno.land/r/")));
  const { genesisStandards, genesisOnlyCount, newlyFetched } =
    await fetchGenesisStandards(net, allRealms, txPaths, prev?.genesisStandards);
  console.log(`genesis-only realms: ${genesisOnlyCount} (${newlyFetched} newly fetched this run)`);

  function activityFor(p) {
    const a = callActivityResult.byPath[p];
    return a
      ? { calls: a.calls, uniqueCallers: a.callers.length, lastBlockHeight: a.lastBlockHeight, lastBlockTime: a.lastBlockTime, topFunc: a.topFunc }
      : { calls: 0, uniqueCallers: 0, lastBlockHeight: null, lastBlockTime: null, topFunc: null };
  }

  // nftRealms/governanceRealms/socialRealms all come from the same
  // per-path tag lookup (tx-deployed packages carry their own tags;
  // genesis-only realms carry theirs from fetchGenesisStandards) — one
  // pass over every known realm path instead of three.
  const nftRealms = [];
  const governanceRealms = [];
  const socialRealms = [];
  for (const p of allRealms) {
    const tags = txPaths.has(p) ? txResult.packages[p] : genesisStandards[p];
    if (!tags) continue;
    if (tags.standard) nftRealms.push({ path: p, standard: tags.standard });
    if (tags.governance) governanceRealms.push({ path: p, ...activityFor(p) });
    if (tags.social) socialRealms.push({ path: p, ...activityFor(p) });
  }
  nftRealms.sort((a, b) => a.path.localeCompare(b.path));
  governanceRealms.sort((a, b) => b.calls - a.calls);
  socialRealms.sort((a, b) => b.calls - a.calls);

  // Trending/active realms and DeFi(Gnoswap) both come straight from call
  // activity, unfiltered by any source-based tag — a realm doesn't need to
  // match the NFT/governance/social heuristics to be "trending", it just
  // needs calls. Gnoswap's whole ecosystem deploys under the
  // `gno.land/r/gnoswap/...` path prefix (confirmed against real deployed
  // paths: pool, router, staker, gov/*, launchpad, etc.) — no separate
  // source-scan heuristic needed, just a prefix filter on the same data.
  const trendingRealms = Object.entries(callActivityResult.byPath)
    .map(([p, a]) => ({
      path: p, calls: a.calls, uniqueCallers: a.callers.length,
      lastBlockHeight: a.lastBlockHeight, lastBlockTime: a.lastBlockTime, topFunc: a.topFunc,
    }))
    .sort((a, b) => b.calls - a.calls);
  const defiRealms = trendingRealms.filter(r => r.path.startsWith("gno.land/r/gnoswap/"));

  const recentDeployed = Object.values(txResult.packages)
    .map(p => ({
      path: p.path,
      blockHeight: p.blockHeight,
      blockTime: p.blockTime || null,
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
    trendingRealms,
    governanceRealms,
    socialRealms,
    defiRealms,
    genesisStandards,
    txPackages: txResult.packages,
    callActivity: { byPath: callActivityResult.byPath, lastHeight: callActivityResult.lastHeight },
    stats: {
      tokenCount: tokens.length,
      nftRealmCount: nftRealms.length,
      totalRealmsScanned: allRealms.length,
      txPackageCount: Object.keys(txResult.packages).length,
      genesisOnlyCount,
      trendingRealmCount: trendingRealms.length,
      governanceRealmCount: governanceRealms.length,
      socialRealmCount: socialRealms.length,
      defiRealmCount: defiRealms.length,
    },
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`wrote ${outPath}`);
}

async function main() {
  // One network's failure (this indexer has genuinely hung mid-query
  // before, not hypothetically) must not discard the other network's
  // successful, already-computed update — each is isolated, and whatever
  // succeeds still gets written and committed. The run is only reported
  // as failed (non-zero exit, visible in the Actions UI) after everything
  // that *could* succeed has been given the chance to.
  let anyFailed = false;
  for (const [netKey, net] of Object.entries(NETWORKS)) {
    try {
      await buildNetwork(netKey, net);
    } catch (err) {
      anyFailed = true;
      console.error(`\n=== ${netKey} FAILED ===`);
      console.error(err);
    }
  }
  if (anyFailed) process.exit(1);
}

main();
