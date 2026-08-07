<?php
/**
 * CORS proxy for gno.land betanet's indexer (indexer.gno.land), which
 * doesn't send Access-Control-Allow-Origin headers — unlike testnet's
 * indexer, which does. That's a config gap on that one deployment, not
 * a policy; this works around it from our own hosting until it's fixed
 * upstream, per the exact pattern documented in gno-observer's
 * index.html (see graphqlQuery()).
 *
 * Deploy: upload this file to any DreamHost-hosted domain/subdomain
 * that serves PHP (DreamHost shared hosting runs PHP by default, no
 * extra setup). Whatever public URL it ends up at (e.g.
 * https://yourdomain.com/gno-betanet-proxy.php) is what gets wired
 * into index.html's graphqlQuery() as the betanet indexer endpoint.
 *
 * Scope, deliberately narrow: forwards ONLY to gno.land's own betanet
 * indexer, over POST, with a JSON body containing a "query" field —
 * the exact shape gno-observer's graphqlQuery() already sends. Not a
 * general-purpose open proxy: the upstream URL is hardcoded, not
 * client-suppliable, so this can't be repurposed to fetch arbitrary
 * sites.
 */

// Public, read-only blockchain data — no auth, no user data, nothing
// sensitive passes through here, so a permissive origin is fine and
// avoids friction (this also gets called from a local file:// origin
// during development, which doesn't send a normal Origin header).
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");
header("Access-Control-Max-Age: 86400");

// Preflight — browsers send this automatically before the real POST
// because of the JSON content type; nothing to do but approve it.
if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    header("Content-Type: application/json");
    echo json_encode(["error" => "Only POST is supported."]);
    exit;
}

const UPSTREAM_URL = "https://indexer.gno.land/graphql/query";
const MAX_BODY_BYTES = 20000; // generous for any query this dashboard sends; guards against pathological input

$body = file_get_contents("php://input", false, null, 0, MAX_BODY_BYTES + 1);
if ($body === false || strlen($body) === 0) {
    http_response_code(400);
    header("Content-Type: application/json");
    echo json_encode(["error" => "Empty request body."]);
    exit;
}
if (strlen($body) > MAX_BODY_BYTES) {
    http_response_code(413);
    header("Content-Type: application/json");
    echo json_encode(["error" => "Request body too large."]);
    exit;
}

// Loose sanity check, not a real security boundary (the fixed upstream
// URL is what actually keeps this narrow) — just rejects obviously
// malformed input before spending a request on the upstream indexer.
$decoded = json_decode($body, true);
if (!is_array($decoded) || !isset($decoded["query"]) || !is_string($decoded["query"])) {
    http_response_code(400);
    header("Content-Type: application/json");
    echo json_encode(["error" => "Expected a JSON body with a \"query\" string field."]);
    exit;
}

$ch = curl_init(UPSTREAM_URL);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => ["Content-Type: application/json"],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 20,
    CURLOPT_FOLLOWLOCATION => false,
]);
$response = curl_exec($ch);
$curlErrno = curl_errno($ch);
$curlError = curl_error($ch);
$httpStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

header("Content-Type: application/json");

if ($curlErrno !== 0) {
    http_response_code(502);
    echo json_encode(["error" => "Couldn't reach the betanet indexer: " . $curlError]);
    exit;
}

http_response_code($httpStatus ?: 502);
echo $response;
