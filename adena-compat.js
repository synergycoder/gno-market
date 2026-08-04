// Empty on purpose. Wallet extensions like Adena inject a content script that
// (per their own shipped code, `content.js` in the extension bundle) tries
// document.currentScript.src first, and when that's unavailable — which it
// always is for a content script, since content scripts aren't real <script>
// elements in the page's DOM — falls back to scanning the page's own <script>
// tags for one with an absolute http(s) src. A page with only inline scripts
// (or none) gives it nothing to find, and the extension throws
// "Automatic publicPath is not supported in this browser" before it can set
// up its API. Loading this empty, harmless file via a real <script src="">
// tag gives that fallback something to find, letting the wallet inject
// correctly. Confirmed against the actual installed Adena extension
// (v1.20.1) source, not just observed behavior.
