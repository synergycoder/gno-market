// Posts pre-approved, pre-scheduled social-queue.json entries to X (Twitter):
// screenshots the live site with a real headless browser, uploads the image,
// and creates the tweet, all signed with OAuth 1.0a using only Node's built-in
// crypto (no OAuth library) — Playwright is the one real dependency here,
// unavoidable since there's no way to render the JS-heavy dashboard without
// an actual browser engine.
import { readFile, writeFile } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { chromium } from "playwright";

const QUEUE_PATH = new URL("../social-queue.json", import.meta.url);
const SITE_URL = "https://gno.observer/";

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// RFC 5849 OAuth 1.0a signing. `params` covers query/form params that must be
// folded into the signature base string — always empty here, since both
// endpoints we call take multipart (media bytes) or JSON (tweet text) bodies,
// neither of which gets signed under the OAuth 1.0a spec.
function buildAuthHeader(method, url, params, creds) {
  const oauthParams = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const allParams = { ...oauthParams, ...params };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(String(allParams[k]))}`)
    .join("&");
  const baseString = [method.toUpperCase(), percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(creds.apiKeySecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ")
  );
}

async function takeScreenshot(tab) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const url = tab ? `${SITE_URL}?tab=${encodeURIComponent(tab)}` : SITE_URL;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2000); // let async tab loaders finish rendering data
    return await page.screenshot({ fullPage: false });
  } finally {
    await browser.close();
  }
}

// Simple (non-chunked) v1.1 upload — fine for a compressed viewport PNG,
// which is well under the 5MB simple-upload ceiling.
async function uploadMedia(imageBuffer, creds) {
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const form = new FormData();
  form.append("media", new Blob([imageBuffer], { type: "image/png" }), "screenshot.png");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: buildAuthHeader("POST", url, {}, creds) },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`media upload failed (${res.status}): ${JSON.stringify(json)}`);
  return json.media_id_string;
}

async function createTweet(text, mediaId, creds) {
  const url = "https://api.twitter.com/2/tweets";
  const body = JSON.stringify(mediaId ? { text, media: { media_ids: [mediaId] } } : { text });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader("POST", url, {}, creds),
      "Content-Type": "application/json",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`tweet creation failed (${res.status}): ${JSON.stringify(json)}`);
  return json.data.id;
}

async function main() {
  const creds = {
    apiKey: process.env.X_API_KEY,
    apiKeySecret: process.env.X_API_KEY_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessTokenSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
  if (!creds.apiKey || !creds.apiKeySecret || !creds.accessToken || !creds.accessTokenSecret) {
    console.log("X API credentials incomplete — skipping this run.");
    return;
  }

  const queue = JSON.parse(await readFile(QUEUE_PATH, "utf8"));
  const now = new Date();
  let changed = false;

  for (const post of queue.posts) {
    if (post.status !== "approved") continue;
    if (new Date(post.scheduledAt) > now) continue;

    console.log(`Posting ${post.id}: "${post.caption.slice(0, 60)}..."`);
    try {
      const screenshot = await takeScreenshot(post.screenshotTab);
      const mediaId = await uploadMedia(screenshot, creds);
      const tweetId = await createTweet(post.caption, mediaId, creds);
      post.status = "posted";
      post.postedAt = now.toISOString();
      post.tweetId = tweetId;
      console.log(`Posted as tweet ${tweetId}`);
    } catch (err) {
      post.status = "failed";
      post.lastError = err.message;
      console.error(`Failed to post ${post.id}: ${err.message}`);
    }
    changed = true;
  }

  if (changed) {
    await writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2) + "\n");
    console.log("Queue updated.");
  } else {
    console.log("No due posts.");
  }
}

main();
