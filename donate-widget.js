// gno-donate-widget.js — a self-contained, drop-in "Donate GNOT" button +
// modal for any static gno.land dashboard/site.
//
// USAGE (copy this file into your project, then in your page):
//   <script src="donate-widget.js"></script>
//   <script>
//     GnoDonate.init({
//       recipient: "g1...",              // REQUIRED — your receiving address
//       projectName: "My Project",       // shown in the modal header
//       appName: "My Project",           // passed to Adena's AddEstablish (per-site whitelist name)
//       chainId: "sapphire-1",           // network the recipient address lives on
//       rpcUrl: "https://rpc.sapphire.testnets.gno.land", // pins the tx to that
//                                         // network via Adena's networkInfo,
//                                         // regardless of Adena's own current
//                                         // chain — omit to skip this (old
//                                         // behavior: signs on whatever chain
//                                         // Adena already has selected)
//       mountSelector: "#donateSlot",    // where to insert the trigger button
//       presetAmounts: [1, 5, 10, 50, 100], // GNOT
//     });
//   </script>
//
// Design notes for reuse across the sibling gno.land projects (see
// ~/gno-land-dev-notes.md): this file is intentionally self-contained —
// its own CSS (scoped under .gnodonate- class names so it can't collide
// with a host page's styles), its own Adena connection state (independent
// of whatever wallet-connect logic the host page already has, e.g.
// gno-observer's Suggestions feature), and no external dependencies. Drop
// the file in, call GnoDonate.init() once, done. The Adena API calls used
// here (AddEstablish/GetAccount/DoContract with a "/bank.MsgSend" message)
// are the same ones verified working in gno-observer's own Suggestions
// feature — see index.html's ensureAdenaConnected()/signMemoTx().
//
// SAFETY: this sends real GNOT to a real address with no undo. init()
// refuses to activate (throws, and does not render a button) unless
// `recipient` looks like a real gno bech32 address — never wire this up
// to a placeholder or guessed address.

(function () {
  "use strict";

  const GNOT_ADDRESS_RE = /^g1[a-z0-9]{38}$/;

  function injectStyles() {
    if (document.getElementById("gnodonate-styles")) return;
    const style = document.createElement("style");
    style.id = "gnodonate-styles";
    style.textContent = `
      .gnodonate-trigger {
        display: inline-flex; align-items: center; gap: 0.4rem;
        font-family: inherit; font-size: 0.92rem; font-weight: 600;
        padding: 0.5rem 0.9rem; border-radius: 8px; cursor: pointer;
        border: 1px dashed rgba(217,122,82,0.5); background: none;
        color: inherit;
      }
      .gnodonate-trigger:hover { background: rgba(217,122,82,0.1); }
      .gnodonate-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.55);
        display: flex; align-items: center; justify-content: center;
        z-index: 9999; padding: 1rem;
      }
      .gnodonate-modal {
        background: var(--bg-elevated, #1c1c1e); color: var(--text, #f2f2f2);
        border: 1px solid var(--border, #333); border-radius: 12px;
        padding: 1.5rem; max-width: 420px; width: 100%;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
        font-family: inherit;
      }
      .gnodonate-modal h3 { margin: 0 0 0.3rem; font-size: 1.15rem; }
      .gnodonate-modal .gnodonate-sub { font-size: 0.85rem; opacity: 0.7; margin: 0 0 1rem; }
      .gnodonate-close {
        float: right; background: none; border: none; font-size: 1.2rem;
        cursor: pointer; color: inherit; opacity: 0.6; line-height: 1;
      }
      .gnodonate-close:hover { opacity: 1; }
      .gnodonate-amounts { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.8rem 0; }
      .gnodonate-amount-btn {
        flex: 1 1 60px; padding: 0.5rem 0.4rem; border-radius: 8px;
        border: 1px solid var(--border, #333); background: none; color: inherit;
        cursor: pointer; font-family: inherit; font-size: 0.9rem;
      }
      .gnodonate-amount-btn.active, .gnodonate-amount-btn:hover {
        border-color: #d97a52; color: #d97a52;
      }
      .gnodonate-custom-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.6rem 0; }
      .gnodonate-custom-row input[type="number"] {
        flex: 1; padding: 0.5rem 0.6rem; border-radius: 8px;
        border: 1px solid var(--border, #333); background: transparent; color: inherit;
        font-family: inherit; font-size: 0.9rem;
      }
      .gnodonate-modal textarea {
        width: 100%; box-sizing: border-box; margin-top: 0.6rem; padding: 0.6rem;
        border-radius: 8px; border: 1px solid var(--border, #333);
        background: transparent; color: inherit; font-family: inherit;
        font-size: 0.88rem; resize: vertical; min-height: 3rem;
      }
      .gnodonate-summary {
        margin-top: 0.9rem; padding: 0.7rem 0.8rem; border-radius: 8px;
        background: rgba(255,255,255,0.04); font-size: 0.85rem; line-height: 1.5;
      }
      .gnodonate-summary code { word-break: break-all; }
      .gnodonate-status { margin-top: 0.7rem; font-size: 0.85rem; min-height: 1.2em; opacity: 0.85; }
      .gnodonate-send-btn {
        margin-top: 0.9rem; width: 100%; padding: 0.65rem; border-radius: 8px;
        border: none; background: #d97a52; color: #1c1c1e; font-weight: 700;
        font-family: inherit; font-size: 0.95rem; cursor: pointer;
      }
      .gnodonate-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .gnodonate-spinner {
        display: inline-block; width: 0.9em; height: 0.9em; margin-right: 0.4em;
        border: 2px solid currentColor; border-right-color: transparent;
        border-radius: 50%; vertical-align: -0.15em;
        animation: gnodonate-spin 0.7s linear infinite;
      }
      @keyframes gnodonate-spin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);
  }

  async function ensureAdenaConnected(appName) {
    if (typeof window.adena === "undefined") {
      throw new Error("Adena not detected — install it from adena.app, then reload the page.");
    }
    const establishRes = await window.adena.AddEstablish(appName);
    const alreadyConnected = /already connected/i.test(establishRes.message || "");
    if (establishRes.status !== "success" && !alreadyConnected) {
      throw new Error(establishRes.message || "Connection request was not approved.");
    }
    const accountRes = await window.adena.GetAccount();
    if (accountRes.status !== "success" || !accountRes.data || !accountRes.data.address) {
      throw new Error(accountRes.message || "Could not read the connected account.");
    }
    return accountRes.data.address;
  }

  async function sendDonation(fromAddress, toAddress, amountUgnot, memo, chainId, rpcUrl) {
    const req = {
      messages: [{
        type: "/bank.MsgSend",
        value: { from_address: fromAddress, to_address: toAddress, amount: `${amountUgnot}ugnot` },
      }],
      memo: memo || "",
    };
    // Without this, the donation signs on whatever chain the user's own
    // Adena happens to be pointed at, which may not be the one `recipient`
    // actually lives on/is being watched on — same mismatch bug found and
    // fixed in gno-observer's own Suggestions feature (see index.html's
    // signMemoTx()). Only added when the host page passes an rpcUrl,
    // keeping this backward-compatible for any integration that hasn't
    // been updated to pass one.
    if (rpcUrl) req.networkInfo = { chainId, rpcUrl };
    const res = await window.adena.DoContract(req);
    if (res.status !== "success") throw new Error(res.message || "Transaction was not approved.");
    return res;
  }

  function truncate(addr) {
    return addr.length > 14 ? `${addr.slice(0, 6)}...${addr.slice(-6)}` : addr;
  }

  function buildModal(config) {
    const overlay = document.createElement("div");
    overlay.className = "gnodonate-overlay";

    const modal = document.createElement("div");
    modal.className = "gnodonate-modal";
    modal.innerHTML = `
      <button class="gnodonate-close" aria-label="Close">✕</button>
      <h3>💛 Donate to ${escapeHtml(config.projectName)}</h3>
      <p class="gnodonate-sub">Sends GNOT directly, wallet-to-wallet — no intermediary.</p>
      <div class="gnodonate-amounts">
        ${config.presetAmounts.map(a => `<button type="button" class="gnodonate-amount-btn" data-amount="${a}">${a} GNOT</button>`).join("")}
      </div>
      <div class="gnodonate-custom-row">
        <label for="gnodonate-custom" style="font-size:0.85rem;white-space:nowrap;">Custom:</label>
        <input type="number" id="gnodonate-custom" min="0" step="0.01" placeholder="Amount in GNOT">
      </div>
      <textarea id="gnodonate-message" placeholder="Optional message (included as the transaction memo)" maxlength="200"></textarea>
      <div class="gnodonate-summary" id="gnodonate-summary">
        Select an amount to continue.
      </div>
      <div class="gnodonate-status" id="gnodonate-status"></div>
      <button class="gnodonate-send-btn" id="gnodonate-send-btn" disabled>Connect wallet &amp; donate</button>
    `;
    overlay.appendChild(modal);

    let selectedAmount = null;
    const summaryEl = modal.querySelector("#gnodonate-summary");
    const statusEl = modal.querySelector("#gnodonate-status");
    const sendBtn = modal.querySelector("#gnodonate-send-btn");
    const customInput = modal.querySelector("#gnodonate-custom");

    function updateSummary() {
      if (!selectedAmount || selectedAmount <= 0) {
        summaryEl.textContent = "Select an amount to continue.";
        sendBtn.disabled = true;
        return;
      }
      summaryEl.innerHTML = `Sending <strong>${selectedAmount} GNOT</strong> to <code>${truncate(config.recipient)}</code> on ${escapeHtml(config.chainId)}.`;
      sendBtn.disabled = false;
    }

    modal.querySelectorAll(".gnodonate-amount-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        modal.querySelectorAll(".gnodonate-amount-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        selectedAmount = Number(btn.dataset.amount);
        customInput.value = "";
        updateSummary();
      });
    });
    customInput.addEventListener("input", () => {
      modal.querySelectorAll(".gnodonate-amount-btn").forEach(b => b.classList.remove("active"));
      selectedAmount = customInput.value ? Number(customInput.value) : null;
      updateSummary();
    });

    sendBtn.addEventListener("click", async () => {
      if (!selectedAmount || selectedAmount <= 0) return;
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<span class="gnodonate-spinner"></span>Waiting for wallet…';
      statusEl.textContent = "Connecting to Adena and requesting your signature…";
      try {
        const fromAddress = await ensureAdenaConnected(config.appName);
        const amountUgnot = Math.round(selectedAmount * 1_000_000);
        const memo = modal.querySelector("#gnodonate-message").value.trim();
        await sendDonation(fromAddress, config.recipient, amountUgnot, memo, config.chainId, config.rpcUrl);
        statusEl.textContent = "Thank you! Your donation was sent.";
        sendBtn.textContent = "Sent ✓";
      } catch (err) {
        statusEl.textContent = "Failed: " + err.message;
        sendBtn.textContent = "Connect wallet & donate";
        sendBtn.disabled = false;
      }
    });

    function close() { overlay.remove(); }
    modal.querySelector(".gnodonate-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", function escHandler(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", escHandler); }
    });

    return overlay;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const GnoDonate = {
    init(userConfig) {
      const config = Object.assign({
        projectName: "this project",
        appName: "GnoDonate",
        chainId: "sapphire-1",
        rpcUrl: "https://rpc.sapphire.testnets.gno.land",
        presetAmounts: [1, 5, 10, 50, 100],
        mountSelector: null,
        buttonText: "💛 Donate",
      }, userConfig || {});

      if (!config.recipient || !GNOT_ADDRESS_RE.test(config.recipient)) {
        console.error(
          "GnoDonate.init(): `recipient` must be a real gno bech32 address (g1...) — " +
          "refusing to render a donate button against an invalid/placeholder address."
        );
        return null;
      }

      injectStyles();

      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "gnodonate-trigger";
      trigger.textContent = config.buttonText;
      trigger.addEventListener("click", () => {
        document.body.appendChild(buildModal(config));
      });

      const mount = config.mountSelector ? document.querySelector(config.mountSelector) : null;
      if (mount) mount.appendChild(trigger);
      else document.body.appendChild(trigger);

      return trigger;
    },
  };

  window.GnoDonate = GnoDonate;
})();
