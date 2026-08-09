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
    chainId: "topaz-1",
    rpcUrl: "https://rpc.topaz.testnets.gno.land",
    indexerUrl: "https://indexer.topaz.testnets.gno.land/graphql/query",
  },
  // The current/latest gno.land testnet as of Aug 2026 — see the matching
  // comment in index.html's own NETWORKS for the "previous testnet" note
  // and CORS confirmation. buildNetwork() below is fully parameterized by
  // netKey/net, so this network gets every generic scan (tokens, NFTs,
  // deployed packages, trending, governance, social, swaps, whale watch)
  // for free — no other code changes needed for the generic path.
  sapphire: {
    label: "sapphire-1 (testnet)",
    chainId: "sapphire-1",
    rpcUrl: "https://rpc.sapphire.testnets.gno.land",
    indexerUrl: "https://indexer.sapphire.testnets.gno.land/graphql/query",
  },
  betanet: {
    label: "gnoland1 (betanet)",
    chainId: "gnoland1",
    rpcUrl: "https://rpc.gno.land",
    indexerUrl: "https://indexer.gno.land/graphql/query",
  },
};

// User-identified faucet wallet — same address checked on both networks;
// see fetchFaucetDrips's own comment for the live confirmation.
const FAUCET_ADDRESS = "g18qhq2fl54lszhmxeyqlvxnwjzc3xpu4nnakclp";

// See fetchGenesisBalanceAddresses's own comment — this bounds how many
// genesis-funded addresses get individually RPC-checked for whale watch.
const GENESIS_ADDRESS_LIMIT = 500;

// Onbloc (the team behind GnoScan and Adena) publishes a curated GRC20
// metadata registry, one JSON file per chain-id, that GnoScan's own token
// page reads directly (confirmed by inspecting gnoscan.io/tokens' actual
// <img> src attributes and cross-checking its displayed decimals against
// this file). This is a much better decimals source than on-chain
// Decimals()/GetDecimals() probing: most real tokens (wugnot included)
// don't expose either function at all, so probing alone left most of the
// table unresolved — this registry has every token GnoScan itself shows.
const TOKEN_RESOURCE_BASE = "https://raw.githubusercontent.com/onbloc/gno-token-resource/main";
async function fetchTokenRegistry(chainId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${TOKEN_RESOURCE_BASE}/grc20/${chainId}.json`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // non-critical enrichment — falls back to on-chain probing below
  } finally {
    clearTimeout(timer);
  }
}

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

// Unlike Decimals()/GetDecimals(), TotalSupply() is exposed consistently
// (confirmed live against every registered token plus wugnot — every one
// answered) and, unlike decimals, is NOT static: mint/burn changes it, so
// this is re-fetched in full every run rather than cached incrementally.
async function fetchTokenTotalSupplies(net, tokenPaths) {
  const results = await mapLimit(tokenPaths, 8, async (path) => {
    for (const fn of ["TotalSupply()", "GetTotalSupply()"]) {
      try {
        const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${path}.${fn}`);
        const m = /^\((\d+)\s+\w+\)/.exec((raw || "").trim());
        if (m) return [path, Number(m[1])];
      } catch {
        // try the next convention
      }
    }
    // Confirmed on gno.land/r/onbloc/ibc/union/apps/ucs03_zkgm: neither
    // convention exists there at all (VM error: "name TotalSupply/
    // GetTotalSupply not declared") — it's an IBC bridge hosting multiple
    // tokens (GetVoucherSize() -> 2 for SepoliaETH+USDT) behind a
    // paginated GetVoucherList(start, count) API with no simple
    // "current total supply" accessor, not a plain GRC20. Left
    // unresolved rather than guessing at bespoke pagination args.
    return [path, null];
  });
  return Object.fromEntries(results);
}

// Swap/Transfer events encode a token as "<realm path>.<SYMBOL>" (e.g.
// "gno.land/r/gnoswap/gns.GNS"), not a bare realm path — calling
// Decimals() (or anything else) against the compound form is a malformed
// vm/qeval expression and silently fails. Strips the appended symbol,
// leaving a real callable path. Duplicated in index.html (no shared
// module between the Node build script and the browser) — keep both in
// sync if this ever changes.
function realmPathOnly(id) {
  const lastSlash = id.lastIndexOf("/");
  const dotAfterSlash = id.indexOf(".", lastSlash);
  return dotAfterSlash === -1 ? id : id.slice(0, dotAfterSlash);
}

// ---------- NFT collection metadata (name/symbol/count) ----------
// GRC721 has no single canonical implementation (confirmed in
// ~/gno-land-dev-notes.md — every project vendors its own copy or
// writes its own), but Name()/Symbol()/TokenCount() are the de-facto
// convention every real deployed collection checked so far exposes
// (confirmed live against two independently-built collections:
// gingernft and tardigrades). Each field is fetched independently with
// its own try/catch — a collection missing one shouldn't blank out the
// others. TokenCount() falls back to TotalSupply() (some collections
// use ERC721Enumerable-style naming instead), same "try convention A
// then B" pattern already used for GRC20 decimals.
async function fetchNftCollectionMeta(net, nftRealms) {
  await mapLimit(nftRealms, 8, async (n) => {
    try {
      const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${n.path}.Name()`);
      const m = /^\("(.*)" string\)/s.exec((raw || "").trim());
      if (m) n.name = m[1];
    } catch {
      // leave n.name unset
    }
    try {
      const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${n.path}.Symbol()`);
      const m = /^\("(.*)" string\)/s.exec((raw || "").trim());
      if (m) n.symbol = m[1];
    } catch {
      // leave n.symbol unset
    }
    for (const fn of ["TokenCount()", "TotalSupply()"]) {
      try {
        const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${n.path}.${fn}`);
        const m = /^\((\d+)\s+\w+\)/.exec((raw || "").trim());
        if (m) { n.tokenCount = Number(m[1]); break; }
      } catch {
        // try the next convention
      }
    }
  });
}

// ---------- NFT collection representative image ----------
// No external image registry exists for NFT collections (unlike GRC20's
// onbloc/gno-token-resource, whose own directory listing has no grc721
// equivalent — checked directly). Falls back to the collection's own
// first-ever-minted token's own image, handled purely as an opaque
// string end to end: the on-chain metadata's `image` field (itself
// commonly a data: URI with the image bytes already base64-encoded
// on-chain — confirmed live against a real deployed collection) is read
// as text and passed straight through to the client's own <img src>,
// the same way GRC20 logos are already just URL strings relayed
// untouched. This script never decodes or inspects the image bytes
// themselves — Buffer.from(...).toString() below is decoding the OUTER
// JSON metadata text, not the image payload nested inside it.
//
// Written to a SEPARATE file (${netKey}-nft-images.json), not the main
// data/${netKey}.json — a single collection's image can be 100KB+ (one
// real example measured at ~126KB), and data/${netKey}.json was just
// cut roughly in half by moving unrelated build-internal state out of
// it (see the internal-state-split commit). Bundling images into every
// visitor's page-load payload would undo that. The client fetches this
// file lazily, only when the NFT Collections tab is actually opened.
async function fetchFirstMintedTokenId(net, collectionPath) {
  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        messages: { value: { MsgCall: { pkg_path: { eq: "${collectionPath}" } } } }
      }) {
        block_height
        response { events { __typename ... on GnoEvent { type attrs { key value } } } }
      }
    }`;
  const data = await graphqlQuery(net.indexerUrl, query, 30000);
  let earliest = null;
  for (const tx of data.getTransactions || []) {
    for (const ev of tx.response?.events || []) {
      if (ev.__typename !== "GnoEvent" || ev.type !== "Mint") continue;
      const attrs = Object.fromEntries((ev.attrs || []).map(a => [a.key, a.value]));
      if (!attrs.tokenId) continue;
      if (!earliest || tx.block_height < earliest.blockHeight) {
        earliest = { blockHeight: tx.block_height, tokenId: attrs.tokenId };
      }
    }
  }
  return earliest?.tokenId ?? null;
}

// Extracts just the `image` field's string VALUE from a token metadata
// URI — never parses or touches the bytes that string points to. Two
// shapes seen/anticipated: JSON metadata embedded as a data: URI (the
// confirmed-live case), or a token URI that IS itself directly an image
// link (no JSON wrapper) for simpler collections.
// Browsers have no native understanding of the ipfs:// URI scheme — an
// <img src="ipfs://..."> just fails to load (silently, since the <img>
// tags here have onerror="this.style.display='none'"), which is exactly
// what "the ipfs ones don't show up" looks like. Rewriting to a public
// gateway is a plain string transform, not image processing.
function normalizeImageUri(uri) {
  if (typeof uri !== "string" || !uri) return null;
  if (/^ipfs:\/\//.test(uri)) return uri.replace("ipfs://", "https://ipfs.io/ipfs/");
  if (/^data:image\//.test(uri) || /^https?:\/\//.test(uri)) return uri;
  return null;
}

function extractImageFromMetadataURI(uri) {
  if (!uri) return null;
  const jsonMatch = /^data:application\/json;base64,(.+)$/.exec(uri);
  if (jsonMatch) {
    try {
      const metadata = JSON.parse(Buffer.from(jsonMatch[1], "base64").toString("utf-8"));
      // The bug this fixes: metadata.image itself can ALSO be an ipfs://
      // link (a very common NFT metadata convention) — the old code
      // returned it verbatim here without ever reaching the ipfs
      // rewrite below, since that branch only ran for the OUTER uri.
      return normalizeImageUri(metadata.image);
    } catch {
      return null;
    }
  }
  return normalizeImageUri(uri);
}

async function fetchNftCollectionImages(net, nftRealms) {
  const images = {};
  await mapLimit(nftRealms, 4, async (n) => {
    try {
      const tokenId = await fetchFirstMintedTokenId(net, n.path);
      if (!tokenId) return;

      // Convention A: TokenURI()/GetTokenURI() returning a single string
      // (a data: URI holding JSON metadata, or a direct image link) —
      // confirmed live against gingernft. Only the FIRST line of the raw
      // response is checked: a (string, error) function still returns
      // "success" from vm/qeval (no thrown error) when it errors
      // on-chain, printing a second line for the error return — matching
      // across both lines with a greedy/dotall regex risks capturing
      // text from that second line's own nested quotes.
      for (const fn of ["GetTokenURI", "TokenURI"]) {
        try {
          const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${n.path}.${fn}("${tokenId}")`);
          const firstLine = (raw || "").trim().split("\n")[0];
          const m = /^\("([^"]*)" string\)$/.exec(firstLine);
          const image = m ? extractImageFromMetadataURI(m[1]) : null;
          if (image) { images[n.path] = image; return; }
        } catch {
          // try the next convention
        }
      }

      // Convention B: TokenMetadata() returning a grc721.Metadata struct
      // directly (Image is its first field, per
      // gno.land/p/.../grc721/igrc721_metadata.gno) — confirmed live
      // against tardigrades, whose TokenURI() exists but always errors
      // "invalid token id" (its own metadata is only reachable this way,
      // not through the more common TokenURI convention). vm/qeval
      // renders a struct as (struct{(field1),(field2),...} typename) in
      // declaration order — only the first field is parsed here.
      try {
        const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${n.path}.TokenMetadata("${tokenId}")`);
        const firstLine = (raw || "").trim().split("\n")[0];
        const m = /^\(struct\{\("([^"]*)" string\)/.exec(firstLine);
        const image = m ? extractImageFromMetadataURI(m[1]) : null;
        if (image) images[n.path] = image;
      } catch {
        // best-effort — not every collection will resolve, leave it out
      }
    } catch {
      // best-effort — not every collection will resolve, leave it out
    }
  });
  return images;
}

// ---------- Ginger Mints (betanet only) — precomputed mint feed for the
// index.html "Ginger NFT Mints" subtab, same shape/logic as its client-side
// live-query fallback (fetchCollectionMintEvents/fetchOwnedTokenMetadata in
// index.html) so the two stay interchangeable. Incremental: a token whose
// metadata was already resolved in a previous run is carried forward
// unchanged rather than re-fetched — metadata for an already-minted token
// never changes, so there's nothing to gain by re-querying it every run.
const GINGER_COLLECTION = {
  path: "gno.land/r/g1n500fmqx8m6tgts85kmn43htegkv0eewkdm4lg/gingernft2",
  name: "Lord G's - Ginge Gnomie",
  maxSupply: 111,
};

async function fetchGingerMintEvents(net) {
  const query = `query {
    getTransactions(where: {
      success: { eq: true },
      messages: { value: { MsgCall: { pkg_path: { eq: "${GINGER_COLLECTION.path}" } } } }
    }, order: { heightAndIndex: DESC }) {
      hash
      block_height
      response { events { __typename ... on GnoEvent { type attrs { key value } } } }
    }
  }`;
  const data = await graphqlQuery(net.indexerUrl, query, 30000);
  const mints = [];
  for (const tx of data.getTransactions || []) {
    for (const ev of tx.response?.events || []) {
      if (ev.__typename !== "GnoEvent" || ev.type !== "Mint") continue;
      const attrs = Object.fromEntries((ev.attrs || []).map(a => [a.key, a.value]));
      if (!attrs.tokenId) continue;
      mints.push({ hash: tx.hash, blockHeight: tx.block_height, tokenId: attrs.tokenId, to: attrs.to || null });
    }
  }
  return mints;
}

// Same two conventions/field order as index.html's parseMetadataURI +
// fetchOwnedTokenMetadata (see those for the confirmation notes) — kept as
// a near-identical port rather than a shared module since this project has
// no build step to share code between the Node script and the static page.
function parseGingerMetadataURI(uri) {
  const jsonMatch = /^data:application\/json;base64,(.+)$/.exec(uri);
  if (jsonMatch) {
    try {
      const meta = JSON.parse(Buffer.from(jsonMatch[1], "base64").toString("utf-8"));
      return {
        image: normalizeImageUri(meta.image),
        name: typeof meta.name === "string" ? meta.name : null,
        description: typeof meta.description === "string" ? meta.description : null,
        attributes: Array.isArray(meta.attributes)
          ? meta.attributes
              .filter((a) => a && typeof a === "object")
              .map((a) => ({
                traitType: typeof a.trait_type === "string" ? a.trait_type : "Trait",
                value: a.value == null ? "" : String(a.value),
              }))
          : null,
      };
    } catch {
      return null;
    }
  }
  const direct = normalizeImageUri(uri);
  return direct ? { image: direct, name: null, description: null, attributes: null } : null;
}

async function fetchGingerTokenMetadata(net, tokenId) {
  const literal = JSON.stringify(tokenId);
  for (const fn of ["GetTokenURI", "TokenURI"]) {
    try {
      const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${GINGER_COLLECTION.path}.${fn}(${literal})`);
      const firstLine = (raw || "").trim().split("\n")[0];
      const m = /^\("([^"]*)" string\)$/.exec(firstLine);
      if (!m) continue;
      const meta = parseGingerMetadataURI(m[1]);
      if (meta) return meta;
    } catch {
      // try the next convention
    }
  }
  try {
    const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${GINGER_COLLECTION.path}.TokenMetadata(${literal})`);
    const firstLine = (raw || "").trim().split("\n")[0];
    const fields = [...firstLine.matchAll(/\((?:"([^"]*)")?\s*string\)/g)].map((m) => m[1] ?? "");
    if (fields.length) {
      return {
        image: normalizeImageUri(fields[0]),
        description: fields[3] || null,
        name: fields[4] || null,
        attributes: null, // struct's Attributes field isn't string-typed — same gap as the client parser
      };
    }
  } catch {
    // best-effort
  }
  return { image: null, name: null, description: null, attributes: null };
}

async function fetchGingerMints(net, prevGingerMints) {
  const mints = await fetchGingerMintEvents(net);
  const prevByToken = new Map((prevGingerMints?.mints || []).map((m) => [m.tokenId, m]));
  let newlyFetched = 0;
  await mapLimit(mints, 6, async (m) => {
    const existing = prevByToken.get(m.tokenId);
    if (existing && existing.image !== undefined) {
      m.image = existing.image;
      m.name = existing.name;
      m.description = existing.description;
      m.attributes = existing.attributes;
      return;
    }
    newlyFetched++;
    const meta = await fetchGingerTokenMetadata(net, m.tokenId);
    m.image = meta.image;
    m.name = meta.name;
    m.description = meta.description;
    m.attributes = meta.attributes;
  });

  const prevTimeByHeight = new Map(
    (prevGingerMints?.mints || []).filter((m) => m.blockTime).map((m) => [m.blockHeight, m.blockTime])
  );
  const heightsNeedingTime = [...new Set(mints.map((m) => m.blockHeight))].filter((h) => !prevTimeByHeight.has(h));
  const blockTimes = heightsNeedingTime.length ? await fetchBlockTimes(net, heightsNeedingTime) : new Map();
  for (const m of mints) m.blockTime = blockTimes.get(m.blockHeight) || prevTimeByHeight.get(m.blockHeight) || null;

  mints.sort((a, b) => b.blockHeight - a.blockHeight);
  return { mints, newlyFetched };
}

// ---------- token decimals ----------
// GRC20 decimals aren't reliably exposed — some implementations expose
// Decimals(), some GetDecimals(), some neither (confirmed directly against
// bare realm paths: GNS responds to Decimals() -> 6, but neither wugnot
// nor the gnoswap test_usdc token responds to either convention).
// Resolved once per token path and cached forever afterward via the
// incremental prevState merge, since a token's decimals never change once
// deployed — never re-fetched for a path that already has an answer (even
// a null one, meaning "confirmed not exposed," not "not checked yet").
// wugnot doesn't expose Decimals()/GetDecimals(), but its decimals are a
// verified fact, not a guess: read directly from source
// (gno.land/r/gnoland/wugnot/wugnot.gno) — Deposit() takes
// `sent.AmountOf("ugnot")` and mints that exact raw amount 1:1
// (`adm.Mint(caller, int64(amount))`, no scaling), so wugnot's subunit is
// identical to native ugnot's — 6 decimals, same as GNOT itself.
const KNOWN_DECIMALS = {
  "gno.land/r/gnoland/wugnot": 6,
};

async function fetchTokenDecimals(net, tokenPaths, prevDecimals, registryDecimals) {
  const known = { ...(prevDecimals || {}) };
  // The onbloc registry (re-fetched fresh every run, see fetchTokenRegistry)
  // is authoritative and re-applied unconditionally — this upgrades any
  // path a previous run cached as null ("no Decimals()/GetDecimals()
  // exposed") the moment it shows up in the registry, without waiting for
  // some future successful RPC probe that may never come.
  for (const [path, decimals] of Object.entries(registryDecimals || {})) {
    if (tokenPaths.includes(path)) known[path] = decimals;
  }
  // KNOWN_DECIMALS is our own source-code-verified override and wins over
  // even the registry (see wugnot's comment above: the registry lists it
  // as decimals=0, but its Deposit() mints 1:1 with raw ugnot, so treating
  // it at GNOT's own 6 decimals is what actually matches user expectations).
  for (const [path, decimals] of Object.entries(KNOWN_DECIMALS)) {
    if (tokenPaths.includes(path)) known[path] = decimals;
  }
  const toFetch = tokenPaths.filter(p => !(p in known));
  await mapLimit(toFetch, 8, async (path) => {
    for (const fn of ["Decimals()", "GetDecimals()"]) {
      try {
        const raw = await abciQuery(net.rpcUrl, "vm/qeval", `${path}.${fn}`);
        const m = /^\((\d+)\s+\w+\)/.exec((raw || "").trim());
        if (m) { known[path] = Number(m[1]); return; }
      } catch {
        // try the next convention
      }
    }
    known[path] = null; // neither convention answered — callers fall back to raw units
  });
  return known;
}

// ---------- NFT standard detection: identical rules to index.html ----------

// Bump this whenever STANDARD_MARKERS/GOVERNANCE_MARKERS/SOCIAL_MARKERS'
// matching LOGIC changes (not just their cache's shape) — both
// fetchDeployedPackages and fetchGenesisStandards re-fetch and re-classify
// any already-known realm whose stored detectionVersion doesn't match this,
// one time, rather than only ever classifying a realm once at first
// discovery and carrying that verdict forward forever. Confirmed live: a
// widened Social heuristic (matching gnochat's Create+Post-shaped functions
// instead of a fixed name list) had zero effect on gnochat specifically
// after shipping, because it had already been classified under the old
// logic — the genesis-realm path's own existing "self-healing" check only
// re-triggers on a cache SHAPE change (old bare-string vs new object), and
// the tx-deployed path had no re-classification mechanism at all.
const DETECTION_VERSION = 2;

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
  // Structural fallback, no keyword mention required: confirmed live
  // against a real chat realm (gno.land/r/.../gnochat) that the marker
  // above completely misses — its functions are CreateChannel/
  // PostMessage/JoinChannel, and neither "board", "blog", nor "social"
  // appears anywhere in its source (checked the full text, not just
  // signatures). A fixed vocabulary of exact function names will always
  // be one naming choice behind whatever the next realm calls its own
  // primitives, so this looks for the SHAPE instead: something that
  // creates a discussion space (channel/board/thread/room/group)
  // together with something that adds content into one (post/send/add a
  // message/post/comment/reply) — both are still function-name
  // patterns, just permissive ones, not a single fixed list.
  {
    funcRe: /func\s+(?:\([^)]*\)\s*)?(Create|New)(Channel|Board|Thread|Room|Group)\s*\(/,
    funcRe2: /func\s+(?:\([^)]*\)\s*)?(Post|Send|Create|New|Add)(Message|Post|Comment|Reply)\s*\(/,
  },
];

function matchesAnyMarker(files, markers) {
  const combined = files.map(f => f.body).join("\n");
  return markers.some(m => m.funcRe2
    ? m.funcRe.test(combined) && m.funcRe2.test(combined)
    : m.mentionRe.test(combined) && m.funcRe.test(combined));
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
        hash
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
        hash: tx.hash,
        creator: v.creator,
        standard: isRealm ? detectStandard(files) : null,
        governance: isRealm ? matchesAnyMarker(files, GOVERNANCE_MARKERS) : false,
        social: isRealm ? matchesAnyMarker(files, SOCIAL_MARKERS) : false,
        detectionVersion: DETECTION_VERSION,
      };
      if (tx.block_height > newHeight) newHeight = tx.block_height;
    }
  }

  // Re-classify any already-known realm left behind by an older
  // DETECTION_VERSION (see that constant's own comment) — the source
  // files aren't sitting in memory from whenever this package was
  // originally discovered, so this re-fetches them via vm/qfile, same as
  // the genesis-only path's own equivalent backfill just below.
  const toReclassify = Object.values(packages).filter(p =>
    p.path.startsWith("gno.land/r/") && p.detectionVersion !== DETECTION_VERSION
  );
  if (toReclassify.length > 0) {
    await mapLimit(toReclassify, 8, async (pkg) => {
      try {
        const listing = await abciQuery(net.rpcUrl, "vm/qfile", pkg.path);
        const filenames = (listing || "").split("\n").map(s => s.trim())
          .filter(n => n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"));
        const files = await mapLimit(filenames, 4, async (name) => {
          try {
            return { name, body: (await abciQuery(net.rpcUrl, "vm/qfile", `${pkg.path}/${name}`)) || "" };
          } catch {
            return { name, body: "" };
          }
        });
        pkg.standard = detectStandard(files);
        pkg.governance = matchesAnyMarker(files, GOVERNANCE_MARKERS);
        pkg.social = matchesAnyMarker(files, SOCIAL_MARKERS);
        pkg.detectionVersion = DETECTION_VERSION;
      } catch {
        // leave this one's classification as-is and try again next run —
        // don't let one flaky fetch discard an otherwise-valid verdict
      }
    });
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

// ---------- GRC20 holder counts: event-replay balance ledger ----------
// GnoScan's own tokens page shows a "Holders" count per token; there's no
// direct query for it (same root limitation as whale watch — no
// accounts/balances query exists anywhere). Confirmed live that a token's
// GRC20 standard emits a plain "Transfer" event (attrs: token, from, to,
// value) for every balance change, INCLUDING mints/burns — the standard
// convention of using an empty-string address as the zero-address
// sentinel (from:"" on mint, to:"" on burn), not a separate Mint/Burn
// event type (checked wugnot's Deposit() directly). Critically, this
// can't be scoped to calls on the token's OWN pkg_path: a swap through
// gno.land/r/gnoswap/router emits Transfer events for the traded tokens
// as a side effect (confirmed live — one router call's events included
// Transfer entries for GNS, wugnot, and USDC together), so the only
// correct source is every exec transaction chain-wide, filtered by the
// event's own `token` attr instead of by caller. Same incremental
// block_height-watermark pattern as fetchCallActivity, but keeps a full
// per-token, per-address running balance (not just a call count) so a
// holder who empties their balance later correctly drops out of the
// count on the next run rather than being counted forever.
// A Transfer event's own `token` attr is shaped `<path>.<SYMBOL>.<suffix>`
// (confirmed live: "gno.land/r/gnoswap/gns.GNS.0000000") — a DIFFERENT
// compound shape than the swap events' bare `<path>.<SYMBOL>` (no
// trailing suffix), so realmPathOnly() alone isn't enough here. This
// matters concretely: gno.land/r/onbloc/ibc/union/apps/ucs03_zkgm hosts
// TWO distinct tokens (SepoliaETH and USDT) under one shared pkg_path —
// keying balances by bare path alone silently merges their holders into
// one pool (confirmed by a first pass at this that produced nonsense
// counts: 25 for both instead of GnoScan's 3 and 30). The symbol segment
// right after the path is the real disambiguator.
function tokenKeyFromTransferAttr(tokenAttr) {
  const path = realmPathOnly(tokenAttr);
  const symbol = tokenAttr.slice(path.length).replace(/^\./, "").split(".")[0] || "";
  return `${path}|${symbol}`;
}

async function fetchTokenHolders(net, tokens, prevState) {
  const lastHeight = prevState?.lastHeight || 0;
  const tokenKeys = tokens.map(t => `${t.path}|${t.symbol}`);
  const tokenKeySet = new Set(tokenKeys);
  const balances = {};
  for (const key of tokenKeys) balances[key] = { ...(prevState?.balances?.[key] || {}) };

  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        block_height: { gt: ${lastHeight} },
        messages: { route: { eq: "vm" }, typeUrl: { eq: "exec" } }
      }) {
        block_height
        response { events { __typename ... on GnoEvent { type attrs { key value } } } }
      }
    }`;
  const data = await graphqlQuery(net.indexerUrl, query, 90000);

  let newHeight = lastHeight;
  for (const tx of data.getTransactions || []) {
    if (tx.block_height > newHeight) newHeight = tx.block_height;
    for (const ev of tx.response?.events || []) {
      if (ev.__typename !== "GnoEvent" || ev.type !== "Transfer") continue;
      const attrs = Object.fromEntries((ev.attrs || []).map(a => [a.key, a.value]));
      if (!attrs.token) continue;
      const key = tokenKeyFromTransferAttr(attrs.token);
      if (!tokenKeySet.has(key)) continue;
      const amount = Number(attrs.value || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const bal = balances[key];
      if (attrs.from) bal[attrs.from] = (bal[attrs.from] || 0) - amount;
      if (attrs.to) bal[attrs.to] = (bal[attrs.to] || 0) + amount;
    }
  }

  const holderCounts = {};
  for (const key of tokenKeys) {
    holderCounts[key] = Object.values(balances[key]).filter(b => b > 0).length;
  }
  return { balances, holderCounts, lastHeight: newHeight };
}

// ---------- faucet drips: every outgoing send from a known faucet wallet ----------
// A user-identified address (confirmed live: 429 outgoing BankMsgSend on
// testnet, in round amounts like 5 or 15 GNOT — a real faucet drip
// pattern, not guessed). Same incremental block_height-watermark query
// shape as fetchBankSendAddresses, but scoped to one specific
// `from_address` and keeping the full per-drip record (recipient,
// amount, tx hash) rather than just a Set of addresses, since the whole
// point here is to list the drips, not just discover wallets. Recipient
// addresses are ALSO folded into the whale-watch known-address set by
// the caller — a wallet that only ever received a faucet drip and never
// did anything else on-chain wouldn't show up in call activity or bank
// sends scoped elsewhere, but a drip is itself a real bank send, so this
// is really the same "known address" signal fetchBankSendAddresses
// already captures, just also kept as a labeled list for its own tab.
async function fetchFaucetDrips(net, faucetAddress, prevState) {
  const lastHeight = prevState?.lastHeight || 0;
  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        block_height: { gt: ${lastHeight} },
        messages: { value: { BankMsgSend: { from_address: { eq: "${faucetAddress}" } } } }
      }) {
        hash
        block_height
        messages { value { ... on BankMsgSend { to_address amount } } }
      }
    }`;
  const data = await graphqlQuery(net.indexerUrl, query, 60000);

  const drips = [...(prevState?.drips || [])];
  let newHeight = lastHeight;
  for (const tx of data.getTransactions || []) {
    for (const msg of tx.messages) {
      const v = msg.value;
      if (!v || !v.to_address) continue;
      const m = /^(\d+)ugnot$/.exec((v.amount || "").trim());
      drips.push({ hash: tx.hash, blockHeight: tx.block_height, blockTime: null, to: v.to_address, amount: m ? Number(m[1]) : null });
    }
    if (tx.block_height > newHeight) newHeight = tx.block_height;
  }

  const heightsNeedingTime = [...new Set(drips.filter(d => !d.blockTime).map(d => d.blockHeight))];
  if (heightsNeedingTime.length > 0) {
    const blockTimes = await fetchBlockTimes(net, heightsNeedingTime);
    for (const d of drips) {
      if (!d.blockTime && blockTimes.has(d.blockHeight)) d.blockTime = blockTimes.get(d.blockHeight);
    }
  }

  return { drips, lastHeight: newHeight };
}

// ---------- bank sends: catches wallets that never called a contract at all ----------
// fetchCallActivity only ever sees addresses that issued a MsgCall/MsgAddPackage
// — a wallet that has only ever sent or received plain native GNOT (a raw
// `/bank.MsgSend`, e.g. an exchange withdrawal or a friend-to-friend
// transfer) never shows up there. The indexer exposes this message type
// directly (route "bank", typeUrl "send", union member `BankMsgSend` with
// `from_address`/`to_address` — confirmed live), so pulling it separately
// and adding both sides of every transfer is the whole fix — same
// incremental block_height-watermark pattern as fetchCallActivity.
async function fetchBankSendAddresses(net, prevState) {
  const lastHeight = prevState?.lastHeight || 0;
  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        block_height: { gt: ${lastHeight} },
        messages: { route: { eq: "bank" }, typeUrl: { eq: "send" } }
      }) {
        block_height
        messages { value { ... on BankMsgSend { from_address to_address } } }
      }
    }`;
  const data = await graphqlQuery(net.indexerUrl, query, 60000);

  const addresses = new Set(prevState?.addresses || []);
  const sizeBefore = addresses.size;
  let newHeight = lastHeight;
  for (const tx of data.getTransactions || []) {
    for (const msg of tx.messages) {
      const v = msg.value;
      if (!v || !v.from_address) continue;
      addresses.add(v.from_address);
      if (v.to_address) addresses.add(v.to_address);
      if (tx.block_height > newHeight) newHeight = tx.block_height;
    }
  }
  return { addresses: [...addresses], lastHeight: newHeight, newCount: addresses.size - sizeBefore };
}

// ---------- genesis-only realms: same qpaths-diff + qfile scan as the client ----------

async function fetchGenesisStandards(net, allRealms, txPaths, prevGenesis) {
  const genesisOnly = allRealms.filter(p => !txPaths.has(p));
  const known = { ...(prevGenesis || {}) };
  // Re-fetch anything left in the old (pre-governance/social) cache shape
  // (a bare standard string or null instead of {standard, governance,
  // social}), OR anything classified under an older DETECTION_VERSION (see
  // that constant's own comment — this is what actually keeps a realm's
  // classification current when the matching LOGIC changes, not just its
  // cache's shape) — cheap either way since the genesis-only set is small
  // (tens of realms, not hundreds).
  const toFetch = genesisOnly.filter(p =>
    !(p in known) || known[p] === null || typeof known[p] !== "object" || known[p].detectionVersion !== DETECTION_VERSION
  );

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
          detectionVersion: DETECTION_VERSION,
        };
      } catch {
        known[p] = { standard: null, governance: false, social: false, detectionVersion: DETECTION_VERSION }; // unreadable, treat as no match rather than retry forever
      }
    });
  }

  return { genesisStandards: known, genesisOnlyCount: genesisOnly.length, newlyFetched: toFetch.length };
}

// ---------- realm imports: dependency popularity + cross-realm graph ----------
// Neither signal exists anywhere on-chain or on the indexer — a Gno
// transaction only records its top-level caller (an EOA), never the
// intermediate realm-to-realm hops inside it, so there's no "call trace"
// to mine. Static source analysis of each realm's own `import (...)`
// block is the only real signal available: which packages/realms a realm
// DECLARES it depends on. That's an accurate proxy for "popularity" (most
// realms import package X) and a reasonable one for "cross-realm calls"
// (a realm importing another realm's own package can call its exported
// functions directly, gno-style) — not a guarantee every import is
// actually invoked at runtime, just what's structurally possible.
// Scans EVERY known realm (not just genesis-only, unlike
// fetchGenesisStandards above) since dependency popularity needs the
// whole graph, not a subset — cached forever per path once resolved,
// since a deployed realm's source is immutable, so only genuinely new
// realms get scanned on any given run.
function extractImports(source) {
  const imports = new Set();
  const blockRe = /import\s*\(([^)]*)\)/g;
  let m;
  while ((m = blockRe.exec(source)) !== null) {
    const lineRe = /"([^"]+)"/g;
    let lm;
    while ((lm = lineRe.exec(m[1])) !== null) imports.add(lm[1]);
  }
  const singleRe = /import\s+(?:\w+\s+)?"([^"]+)"/g;
  let sm;
  while ((sm = singleRe.exec(source)) !== null) imports.add(sm[1]);
  return [...imports].filter(p => p.startsWith("gno.land/"));
}

async function fetchRealmImports(net, allRealms, prevImports) {
  const known = { ...(prevImports || {}) };
  const toFetch = allRealms.filter(p => !(p in known));

  if (toFetch.length > 0) {
    await mapLimit(toFetch, 8, async (p) => {
      try {
        const listing = await abciQuery(net.rpcUrl, "vm/qfile", p);
        const filenames = (listing || "").split("\n").map(s => s.trim())
          .filter(n => n.endsWith(".gno") && !n.endsWith("_test.gno") && !n.endsWith("_filetest.gno"));
        const files = await mapLimit(filenames, 4, async (name) => {
          try {
            return (await abciQuery(net.rpcUrl, "vm/qfile", `${p}/${name}`)) || "";
          } catch {
            return "";
          }
        });
        known[p] = extractImports(files.join("\n"));
      } catch {
        known[p] = []; // unreadable, treat as no declared imports rather than retry forever
      }
    });
  }

  return { imports: known, newlyFetched: toFetch.length };
}

// Two views over the same import data: which packages/realms are
// depended on by the most OTHER realms (popularity), and the subset of
// those imports that point at another REALM specifically (a `r/` path,
// as opposed to a reusable `p/` package) — the closest available proxy
// for an actual cross-realm call graph.
function buildDependencyViews(importsByPath) {
  const dependents = new Map(); // imported path -> Set of realm paths that import it
  for (const [realmPath, imports] of Object.entries(importsByPath)) {
    for (const imp of imports) {
      if (imp === realmPath) continue; // a self-referential import isn't a real dependency
      if (!dependents.has(imp)) dependents.set(imp, new Set());
      dependents.get(imp).add(realmPath);
    }
  }

  const popularDependencies = [...dependents.entries()]
    .map(([path, realms]) => ({ path, dependentCount: realms.size, kind: path.includes("/p/") ? "Package" : path.includes("/r/") ? "Realm" : "Other" }))
    .sort((a, b) => b.dependentCount - a.dependentCount)
    .slice(0, 100);

  const crossRealmEdges = [];
  for (const [realmPath, imports] of Object.entries(importsByPath)) {
    for (const imp of imports) {
      if (imp !== realmPath && imp.includes("/r/")) crossRealmEdges.push({ from: realmPath, to: imp });
    }
  }

  return { popularDependencies, crossRealmEdges };
}

// ---------- Gnoswap swaps (incremental) ----------
// Every ExactIn/ExactOutSwap event emitted by gno.land/r/gnoswap/router/v1,
// found by pulling every call to the outer gno.land/r/gnoswap/router proxy
// and filtering its emitted events, rather than trying to enumerate and
// re-interpret all 4 of the router's entry functions' own argument shapes
// (ExactIn/OutSingle/MultiSwapRoute) — the event is the canonical summary
// of the executed swap regardless of which entry point or how many hops,
// confirmed directly against real transactions: `resultOutputAmount` is
// the actual amount received (negative-signed), not the caller-supplied
// `amountOutMin` slippage floor from the call args, which is 0 in most
// real calls and would be useless for display.
async function fetchGnoswapSwaps(net, prevState) {
  const lastHeight = prevState?.lastHeight || 0;
  const query = `
    query {
      getTransactions(where: {
        success: { eq: true },
        block_height: { gt: ${lastHeight} },
        messages: { value: { MsgCall: { pkg_path: { eq: "gno.land/r/gnoswap/router" } } } }
      }) {
        hash
        block_height
        messages { value { ... on MsgCall { caller } } }
        response { events { __typename ... on GnoEvent { type pkg_path attrs { key value } } } }
      }
    }`;
  const data = await graphqlQuery(net.indexerUrl, query, 60000);

  // Keyed by hash#index (not just hash) since one call can in principle
  // emit more than one swap event.
  const swaps = { ...(prevState?.swaps || {}) };
  let newHeight = lastHeight;
  let newCount = 0;
  for (const tx of data.getTransactions || []) {
    const caller = tx.messages?.[0]?.value?.caller;
    if (tx.block_height > newHeight) newHeight = tx.block_height;
    let idx = 0;
    for (const ev of tx.response?.events || []) {
      if (ev.__typename !== "GnoEvent") continue;
      if (ev.type !== "ExactInSwap" && ev.type !== "ExactOutSwap") continue;
      const attrs = Object.fromEntries((ev.attrs || []).map(a => [a.key, a.value]));
      swaps[`${tx.hash}#${idx++}`] = {
        hash: tx.hash,
        blockHeight: tx.block_height,
        caller,
        tokenIn: attrs.input,
        tokenOut: attrs.output,
        amountIn: attrs.resultInputAmount,
        amountOut: (attrs.resultOutputAmount || "").replace(/^-/, ""), // sign indicates direction (out), magnitude is what a user wants displayed
      };
      newCount++;
    }
  }

  const heightsNeedingTime = [...new Set(
    Object.values(swaps).filter(s => !s.blockTime).map(s => s.blockHeight)
  )];
  if (heightsNeedingTime.length > 0) {
    const blockTimes = await fetchBlockTimes(net, heightsNeedingTime);
    for (const s of Object.values(swaps)) {
      if (!s.blockTime && blockTimes.has(s.blockHeight)) s.blockTime = blockTimes.get(s.blockHeight);
    }
  }

  return { swaps, lastHeight: newHeight, newCount };
}

// ---------- genesis-funded addresses ----------
// Checked deeply (per an explicit ask) for any way to enumerate every
// address with a balance, beyond just ones already seen in transaction
// history. Confirmed by reading the actual tm2/gno.land source
// (tm2/pkg/sdk/auth/handler.go): the auth module's ABCI query surface
// exposes exactly two paths, "accounts" (single-address lookup) and
// "gasprice" — no "list all accounts" query exists, unlike some newer
// Cosmos SDK chains' gRPC-gateway bank queries (gno.land's tm2 stack is a
// from-scratch reimplementation, not literally cosmos-sdk, and doesn't
// have that gateway). The underlying keeper DOES support full iteration
// (IterateAccounts exists in tm2/pkg/sdk/auth/keeper.go) — the capability
// exists in the node's own state, it's just not exposed to a remote RPC
// client at all.
//
// One real, usable source WAS found: the standard Tendermint2 `/genesis`
// RPC endpoint returns the full genesis doc, including
// `app_state.balances` — the chain's initial funding allocations. For
// topaz-1 this is small (19 addresses, confirmed directly), not a general
// "every holder" list, but it's a real, free expansion of the known-set:
// checked against this project's existing known-active addresses, 18 of
// the 19 weren't already covered, several with genesis allocations in
// the trillions of GNOT. (GnoScan's own homepage shows "622,759 Airdrop
// Holders" — that number is NOT in genesis.json's balances array, so it's
// almost certainly a separate claim-based airdrop realm's own internal
// ledger, not raw genesis state. Enumerating that would need finding and
// querying that specific realm's claim records — a bigger, separate
// research task, not done here.)
async function fetchGenesisBalanceAddresses(net) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${net.rpcUrl}/genesis`, { signal: controller.signal });
    const json = await res.json();
    const balances = json?.result?.genesis?.app_state?.balances || [];
    // The comment above this function was written against testnet's own
    // genesis (19 addresses, confirmed directly) — betanet's turned out
    // to hold 3.26 MILLION balance entries instead (confirmed live: even
    // downloading the raw /genesis response timed out well past 200s at
    // 80MB+ and still wasn't done). RPC-checking every single one of
    // those individually, every 30-minute cycle, was the actual cause of
    // the multi-hour whale-watch hangs (see fetchWhaleWatch's own
    // comment) — millions of addresses at even a few hundred ms each is
    // hours of work, not minutes, no matter how much concurrency or
    // retry tuning happens downstream.
    //
    // Capped to the richest GENESIS_ADDRESS_LIMIT by their genesis-
    // allocated amount — parsed straight out of this same response, no
    // extra RPC call needed to rank them — since those are the only ones
    // remotely plausible as an actual "whale" anyway; a mass-airdrop's
    // long tail is almost certainly small, similarly-sized dust. Each
    // surviving address still gets a real, live RPC balance check
    // downstream in fetchWhaleWatch, same as every other known address —
    // this only bounds how many are ever considered, not how accurately
    // the survivors are reported.
    const parsed = balances
      .map(b => {
        const [addr, amountStr] = b.split("=");
        const m = /^(\d+)ugnot$/.exec(amountStr || "");
        return addr && m ? { addr, amount: Number(m[1]) } : null;
      })
      .filter(Boolean);
    parsed.sort((a, b) => b.amount - a.amount);
    return parsed.slice(0, GENESIS_ADDRESS_LIMIT).map(p => p.addr);
  } catch {
    return []; // non-critical enrichment — a failure here shouldn't fail the whole build
  } finally {
    clearTimeout(timer);
  }
}

// ---------- whale watch: native GNOT balance of every known-active address ----------
// The indexer exposes no accounts/balances query at all (confirmed via
// schema introspection — only latestBlockHeight/getBlocks/getTransactions
// exist), and reconstructing native GNOT balances from transfer events
// would be unreliable anyway (gas fees, genesis airdrops, and internal
// contract-to-contract sends don't surface as any indexed event/message,
// unlike GRC20 transfers which are fully event-driven by the standard).
// Instead: query the REAL, current balance via RPC for every known
// address (transaction-observed, per fetchWhaleWatch's caller, plus
// genesis-funded, per fetchGenesisBalanceAddresses above) — a "known"
// ranking, not a true global top-N (there's no way to enumerate literally
// every address that has ever existed on the chain), but every number
// shown is exact, not estimated. Re-fetched in full every run rather than
// cached incrementally — unlike a monotonic counter, a balance can go
// down, so a "only fetch what's missing" cache would go stale.
async function fetchWhaleWatch(net, knownAddresses, genesisAddresses) {
  // This step runs LAST in each network's build, checks every known
  // address's balance individually (no caching — see the comment at this
  // function's call site), and has been observed live to occasionally
  // stall for 7+ minutes against a growing known-address list (1773
  // addresses on betanet, still climbing) even though every individual
  // abciQuery call already has its own 15s timeout and a sample batch
  // tested clean from outside CI — the exact trigger looks environment/
  // volume-specific (this RPC endpoint's own comment elsewhere already
  // notes it has "genuinely hung mid-query before"), not reproducible on
  // demand. Rather than chase that further, this step now can't
  // single-handedly blow the whole job's time budget (see the workflow's
  // timeout-minutes): once the soft deadline passes, no NEW address
  // checks start — already-in-flight ones still finish (bounded by their
  // own abciQuery timeout) — and whatever's resolved by then still gets
  // returned, so the rest of the build (and the commit/push step after
  // it) isn't held hostage by a slow tail of this one list.
  const deadline = Date.now() + 8 * 60 * 1000;
  let skipped = 0;
  const results = await mapLimit([...knownAddresses], 8, async (addr) => {
    if (Date.now() > deadline) { skipped++; return null; }
    const genesis = genesisAddresses.has(addr);
    // One retry on failure before giving up on this address. This pass
    // runs LAST in the build (after every other, now-heavier scan), so by
    // the time it starts the RPC endpoint has already handled a lot of
    // traffic this run — a transient timeout here is common enough that a
    // single retry measurably improves the resolved count without much
    // added runtime (retries are rare, and only for addresses that
    // actually failed once, not a blanket second pass over everything).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await abciQuery(net.rpcUrl, "auth/accounts/" + addr, "");
        if (!raw || raw.trim() === "null") return { address: addr, balance: 0, genesis };
        const parsed = JSON.parse(raw);
        const coins = parsed?.BaseAccount?.coins || "";
        const m = /^(\d+)ugnot$/.exec(coins.trim());
        return { address: addr, balance: m ? Number(m[1]) : 0, genesis };
      } catch {
        if (attempt === 1) return null; // leave this address out rather than reporting a false 0
      }
    }
  });
  if (skipped > 0) console.log(`whale watch: hit the time budget, skipped ${skipped} addresses this run (will retry next run)`);
  return results.filter(Boolean).sort((a, b) => b.balance - a.balance);
}

// ---------- per-network orchestration ----------

async function buildNetwork(netKey, net) {
  console.log(`\n=== ${netKey} (${net.label}) ===`);
  const outPath = path.join(DATA_DIR, `${netKey}.json`);
  const internalPath = path.join(DATA_DIR, `${netKey}.internal.json`);
  const nftImagesPath = path.join(DATA_DIR, `${netKey}-nft-images.json`);
  const gingerMintsPath = path.join(DATA_DIR, `${netKey}-ginger-mints.json`);
  // Two files: outPath is what every visitor downloads (client-shipped
  // fields only); internalPath holds incremental-cache state the client
  // never reads (raw per-realm import lists, the full swap/faucet-drip
  // incremental ledgers, etc.) — needed to resume future runs without a
  // full re-scan, but shipping it to visitors was pure waste (confirmed:
  // swapActivity/faucetDripsActivity/txPackages/realmImports/
  // genesisStandards alone were roughly half of testnet.json's size,
  // and zero client-side code reads any of them — only the derived
  // arrays/objects built from them, like gnoswapSwaps or recentDeployed,
  // are actually used). Merged into one `prev` object so every existing
  // `prev?.xxx` read below keeps working regardless of which file a
  // field ends up living in — only the read/write edges here changed.
  let prev = null;
  try {
    const [publicPrev, internalPrev] = await Promise.all([
      readFile(outPath, "utf-8").then(JSON.parse).catch(() => ({})),
      readFile(internalPath, "utf-8").then(JSON.parse).catch(() => ({})),
    ]);
    prev = { ...publicPrev, ...internalPrev };
    if (Object.keys(prev).length === 0) prev = null;
  } catch {
    // no previous run, or corrupt — start fresh
  }
  const prevGingerMints = netKey === "betanet"
    ? await readFile(gingerMintsPath, "utf-8").then(JSON.parse).catch(() => null)
    : null;

  const [tokens, allRealmsRaw, txResult, callActivityResult, swapsResult, bankSendResult, tokenRegistry, faucetResult] = await Promise.all([
    fetchTokens(net),
    abciQuery(net.rpcUrl, "vm/qpaths", "gno.land/r/"),
    fetchDeployedPackages(net, prev),
    fetchCallActivity(net, prev?.callActivity),
    fetchGnoswapSwaps(net, prev?.swapActivity),
    fetchBankSendAddresses(net, prev?.bankSendActivity),
    fetchTokenRegistry(net.chainId),
    fetchFaucetDrips(net, FAUCET_ADDRESS, prev?.faucetDripsActivity),
  ]);
  console.log(`tokens: ${tokens.length}`);
  console.log(`tx-deployed packages: ${Object.keys(txResult.packages).length} (${txResult.newCount} new this run)`);
  console.log(`call activity: ${Object.keys(callActivityResult.byPath).length} realms with calls (${callActivityResult.newCount} new calls this run)`);
  console.log(`gnoswap swaps: ${Object.keys(swapsResult.swaps).length} (${swapsResult.newCount} new this run)`);
  console.log(`bank sends: ${bankSendResult.addresses.length} addresses seen (${bankSendResult.newCount} new this run)`);
  console.log(`token registry: ${tokenRegistry.length} entries fetched from onbloc/gno-token-resource`);
  console.log(`faucet drips: ${faucetResult.drips.length} total from ${FAUCET_ADDRESS}`);

  // Keyed by "path|SYMBOL" first (a path can host more than one token —
  // e.g. the ucs03_zkgm IBC bridge realm registers both SepoliaETH and
  // USDT under one pkg_path with different decimals), falling back to a
  // bare-path map for lookups that only have the path (like tokenDecimals,
  // which is keyed by realmPathOnly() and can't disambiguate by symbol).
  const registryByPathSymbol = new Map();
  const registryByPath = new Map();
  for (const entry of tokenRegistry) {
    if (!entry.pkg_path) continue;
    registryByPathSymbol.set(`${entry.pkg_path}|${entry.symbol}`, entry);
    if (!registryByPath.has(entry.pkg_path)) registryByPath.set(entry.pkg_path, entry);
  }
  const registryDecimals = Object.fromEntries(
    [...registryByPath.entries()].map(([p, e]) => [p, e.decimals])
  );
  function imageUrlFor(entry) {
    return entry && entry.image ? `${TOKEN_RESOURCE_BASE}${entry.image}` : null;
  }
  for (const t of tokens) {
    const entry = registryByPathSymbol.get(`${t.path}|${t.symbol}`) || registryByPath.get(t.path);
    t.image = imageUrlFor(entry);
    t.description = entry?.description || null;
  }

  const allRealms = (allRealmsRaw || "").split("\n").map(s => s.trim()).filter(Boolean);
  const txPaths = new Set(Object.keys(txResult.packages).filter(p => p.startsWith("gno.land/r/")));
  const { genesisStandards, genesisOnlyCount, newlyFetched } =
    await fetchGenesisStandards(net, allRealms, txPaths, prev?.genesisStandards);
  console.log(`genesis-only realms: ${genesisOnlyCount} (${newlyFetched} newly fetched this run)`);

  const { imports: realmImports, newlyFetched: importsNewlyFetched } =
    await fetchRealmImports(net, allRealms, prev?.realmImports);
  const { popularDependencies, crossRealmEdges } = buildDependencyViews(realmImports);
  console.log(`realm imports: ${allRealms.length} realms scanned (${importsNewlyFetched} newly fetched this run), ${popularDependencies.length} distinct dependencies, ${crossRealmEdges.length} cross-realm edges`);

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

  await fetchNftCollectionMeta(net, nftRealms);
  console.log(`nft collection metadata: ${nftRealms.filter(n => n.name).length}/${nftRealms.length} names resolved`);

  const nftImages = await fetchNftCollectionImages(net, nftRealms);
  console.log(`nft collection images: ${Object.keys(nftImages).length}/${nftRealms.length} resolved`);

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

  const gnoswapSwaps = Object.values(swapsResult.swaps)
    .map(s => ({
      hash: s.hash, blockHeight: s.blockHeight, blockTime: s.blockTime || null, caller: s.caller,
      tokenIn: s.tokenIn, tokenOut: s.tokenOut, amountIn: s.amountIn, amountOut: s.amountOut,
    }))
    .sort((a, b) => b.blockHeight - a.blockHeight);

  const recentDeployed = Object.values(txResult.packages)
    .map(p => ({
      path: p.path,
      blockHeight: p.blockHeight,
      blockTime: p.blockTime || null,
      hash: p.hash || null,
      creator: p.creator,
      kind: p.path.startsWith("gno.land/r/") ? "Realm" : "Package",
    }))
    .sort((a, b) => b.blockHeight - a.blockHeight);

  const tokenPathsNeedingDecimals = new Set(tokens.map(t => t.path));
  for (const s of gnoswapSwaps) {
    if (s.tokenIn) tokenPathsNeedingDecimals.add(realmPathOnly(s.tokenIn));
    if (s.tokenOut) tokenPathsNeedingDecimals.add(realmPathOnly(s.tokenOut));
  }
  const tokenDecimals = await fetchTokenDecimals(net, [...tokenPathsNeedingDecimals], prev?.tokenDecimals, registryDecimals);
  console.log(`token decimals: ${Object.values(tokenDecimals).filter(d => d != null).length}/${Object.keys(tokenDecimals).length} resolved`);

  const totalSupplies = await fetchTokenTotalSupplies(net, tokens.map(t => t.path));
  for (const t of tokens) t.totalSupply = totalSupplies[t.path] ?? null;
  console.log(`token total supplies: ${Object.values(totalSupplies).filter(s => s != null).length}/${tokens.length} resolved`);

  const { balances: tokenHolderBalances, holderCounts, lastHeight: tokenHoldersLastHeight } =
    await fetchTokenHolders(net, tokens, prev?.tokenHolders);
  for (const t of tokens) t.holderCount = holderCounts[`${t.path}|${t.symbol}`] ?? 0;
  console.log(`token holders: ${Object.values(holderCounts).reduce((a, b) => a + b, 0)} total holder-rows across ${tokens.length} tokens`);

  const knownAddresses = new Set();
  for (const p of Object.values(txResult.packages)) if (p.creator) knownAddresses.add(p.creator);
  for (const a of Object.values(callActivityResult.byPath)) for (const c of a.callers) knownAddresses.add(c);
  for (const s of Object.values(swapsResult.swaps)) if (s.caller) knownAddresses.add(s.caller);
  for (const addr of bankSendResult.addresses) knownAddresses.add(addr);
  for (const d of faucetResult.drips) if (d.to) knownAddresses.add(d.to);
  const genesisAddrs = await fetchGenesisBalanceAddresses(net);
  const genesisAddrSet = new Set(genesisAddrs);
  for (const addr of genesisAddrs) knownAddresses.add(addr);
  const whaleWatch = await fetchWhaleWatch(net, knownAddresses, genesisAddrSet);
  console.log(`whale watch: ${whaleWatch.length}/${knownAddresses.size} known addresses checked (${genesisAddrs.length} from genesis balances, ${bankSendResult.addresses.length} from bank sends)`);

  let gingerMints = null;
  if (netKey === "betanet") {
    const result = await fetchGingerMints(net, prevGingerMints);
    gingerMints = { generatedAt: new Date().toISOString(), mints: result.mints };
    console.log(`ginger mints: ${result.mints.length} total (${result.newlyFetched} newly fetched this run)`);
  }

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
    gnoswapSwaps,
    whaleWatch,
    faucetDrips: faucetResult.drips.slice().sort((a, b) => b.blockHeight - a.blockHeight),
    faucetAddress: FAUCET_ADDRESS,
    tokenDecimals,
    // Small (a dozen-ish entries), so shipped in full rather than
    // pre-joined against every other table — lets the client look up a
    // logo/description by path+symbol wherever a token identity shows up
    // (Swaps' tokenIn/tokenOut, Scan Wallet's held tokens, etc.), not just
    // the Fungible Tokens tab's own `tokens[]` rows (which already carry
    // their own `image`/`description` fields, joined above).
    tokenRegistry: [...registryByPathSymbol.values()].map(e => ({
      path: e.pkg_path, symbol: e.symbol, decimals: e.decimals, image: imageUrlFor(e), name: e.name,
    })),
    popularDependencies,
    crossRealmEdges,
    callActivity: { byPath: callActivityResult.byPath, lastHeight: callActivityResult.lastHeight },
    bankSendActivity: { addresses: bankSendResult.addresses, lastHeight: bankSendResult.lastHeight },
    tokenHolders: { balances: tokenHolderBalances, lastHeight: tokenHoldersLastHeight },
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
      gnoswapSwapCount: gnoswapSwaps.length,
      whaleWatchCount: whaleWatch.length,
      popularDependencyCount: popularDependencies.length,
      crossRealmEdgeCount: crossRealmEdges.length,
      faucetDripCount: faucetResult.drips.length,
    },
  };

  // Build-internal only — the incremental-cache state needed to resume
  // future runs without a full re-scan, but never read by the client (see
  // the comment on `prev` above for which fields and why).
  const internalState = {
    genesisStandards,
    realmImports,
    txPackages: txResult.packages,
    swapActivity: { swaps: swapsResult.swaps, lastHeight: swapsResult.lastHeight },
    faucetDripsActivity: { drips: faucetResult.drips, lastHeight: faucetResult.lastHeight },
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2));
  await writeFile(internalPath, JSON.stringify(internalState, null, 2));
  await writeFile(nftImagesPath, JSON.stringify(nftImages, null, 2));
  if (gingerMints) await writeFile(gingerMintsPath, JSON.stringify(gingerMints, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(`wrote ${internalPath}`);
  console.log(`wrote ${nftImagesPath}`);
  if (gingerMints) console.log(`wrote ${gingerMintsPath}`);
}

async function main() {
  // One network's failure (this indexer has genuinely hung mid-query
  // before, not hypothetically) must not discard the other network's
  // successful, already-computed update — each is isolated, and whatever
  // succeeds still gets written and committed. The run is only reported
  // as failed (non-zero exit, visible in the Actions UI) after everything
  // that *could* succeed has been given the chance to.
  // Local-dev convenience — unset in CI, so the scheduled run always does
  // both networks. e.g. `ONLY_NETWORK=betanet node scripts/build-cache.mjs`
  // to iterate on a betanet-only change without paying the testnet scan cost.
  const only = process.env.ONLY_NETWORK;
  let anyFailed = false;
  for (const [netKey, net] of Object.entries(NETWORKS)) {
    if (only && netKey !== only) continue;
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
