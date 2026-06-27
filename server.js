#!/usr/bin/env node
/**
 * Lepton Press — a nanopayment paywall, settled on Arc with StreamPay.
 *
 * A publisher serves articles paragraph by paragraph. Each paragraph is gated behind
 * HTTP 402 and priced in micro-USDC (1 µUSDC = $0.000001) by its word count — a price
 * no card rail can serve. Payment is NOT a one-shot charge: the reader opens a StreamPay
 * micro-stream to this publisher's address, and the server PULLS the USDC that has vested
 * each time it releases a paragraph. Pay-per-second-of-reading, settled on chain.
 *
 * Endpoints:
 *   GET /article/:id                    -> 200, the table of contents + per-paragraph
 *                                          prices + machine-readable x402 payment terms.
 *   GET /article/:id/p/:n               -> 402 (no stream) with terms, or, with ?stream=ID:
 *                                          reads the stream on chain, withdraw()s the
 *                                          vested USDC (real Arc tx), and returns the
 *                                          paragraph text + the settlement tx hash.
 *   GET /stats                          -> live revenue ledger for the creator dashboard.
 *
 * Env:
 *   SERVER_PRIVATE_KEY  publisher key that receives + withdraws the stream   [required]
 *   RPC_URL             Arc Testnet RPC                                       [default below]
 *   STREAM_PAY          StreamPay address                                     [default = live USDC deploy]
 *   PORT                listen port                                           [default 4030]
 */
import http from "node:http";
import { ethers } from "ethers";
import { ARTICLES, paragraphPrice, wordCount, PER_WORD_UUSDC } from "./content.js";

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const EXPLORER = "https://testnet.arcscan.app";
const STREAM_PAY = process.env.STREAM_PAY || "0x505739d33D85AD85D0f9eeE64856309782382450";
// USDC on Arc — the native gas token, addressed as an ERC-20. The x402 `asset` field.
const USDC = process.env.USDC || "0x3600000000000000000000000000000000000000";
const PORT = Number(process.env.PORT || 4030);
// Gas-burn floor: never broadcast a withdraw that settles less than this (a withdraw costs
// gas the PUBLISHER pays, so settling dust is net-negative and a griefing vector). The reader
// just lets a little more vest and retries. Default 100 µUSDC ($0.0001) — below a normal
// paragraph price, so it never changes honest flow; it only blocks dust withdraws.
const MIN_SETTLE_UUSDC = BigInt(process.env.MIN_SETTLE_UUSDC || 100);
// Access-signature freshness window (seconds): bounds replay of a captured access signature.
const SIG_TTL_SECS = Number(process.env.SIG_TTL_SECS || 120);
// Hard cap on waiting for a withdraw to mine. If a tx hangs, we must not stall the serialized
// withdraw chain forever — time out, answer 402, and let the reader retry. We never reset the
// nonce by hand (that risks a replacement/gap wedge); the next withdraw simply reads the
// "pending" nonce (ethers' default), so a still-pending tx just takes the next slot.
const WITHDRAW_TIMEOUT_MS = Number(process.env.WITHDRAW_TIMEOUT_MS || 45000);

const SP_ABI = [
  "function get(uint256) view returns (tuple(address sender,address recipient,uint256 deposit,uint256 withdrawn,uint64 start,uint64 stop,uint8 status))",
  "function recipientBalance(uint256) view returns (uint256)",
  "function withdraw(uint256,uint256)",
  "event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount)",
];

const usd = (v) => (Number(v) / 1e6).toFixed(6);
// Effective per-paragraph price: the word price, raised to the dust floor. This is EXACTLY
// what settles on chain (`need` below), so the advertised ToC price equals what the reader
// pays — no over-charge. For a paragraph priced below the floor, the floor binds and is
// disclosed in the x402 pricing string so the number is self-explanatory (not a silent markup).
const effectivePrice = (text) => { const p = paragraphPrice(text); return p > MIN_SETTLE_UUSDC ? p : MIN_SETTLE_UUSDC; };

// Stream- and paragraph-scoped access challenge. The caller signs this with the key that
// funded the stream (st.sender), proving ownership before we spend it on their behalf.
// Binding the paragraph index `n` (not just the stream) means a captured signature can only
// re-fetch the SAME paragraph — an idempotent re-read — instead of being replayed across
// every paragraph of the article within the TTL window. Must match the reader byte-for-byte.
const accessMessage = (streamId, n, ts) => `Lepton Press access\nstream: ${streamId}\nparagraph: ${n}\nts: ${ts}`;

const pk = process.env.SERVER_PRIVATE_KEY;
if (!pk) { console.error("Set SERVER_PRIVATE_KEY (the publisher's testnet key)."); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(pk, provider);
const SERVER_ADDR = wallet.address;
const sp = new ethers.Contract(STREAM_PAY, SP_ABI, wallet);

// Withdraw serialization. Every paragraph settles via `wallet` — one signer, one nonce
// sequence. Node's HTTP server is concurrent, so two readers hitting the paywall at the
// same instant would both grab the same `pending` nonce and one withdraw tx would be
// dropped / "replacement underpriced", wedging the wallet. A promise-chain mutex forces
// withdraws to broadcast-and-mine strictly one at a time, so each reads a fresh nonce only
// after the previous tx is mined. Throughput cost is fine for nanopayment settlements.
let withdrawChain = Promise.resolve();
function serializeWithdraw(fn) {
  const run = withdrawChain.then(fn, fn); // run after the previous settle, win or lose
  withdrawChain = run.then(() => {}, () => {}); // keep the chain alive, swallow into the lock only
  return run; // caller still sees the real result / rejection
}

// Single-use access signatures. A signature is consumed ONLY when it actually settles a
// withdraw — never on a 402 — so the reader's legitimate poll loop (it signs once per paragraph
// then retries the same request while funds vest) is untouched, while a captured signature can
// never be replayed after the paragraph has been paid for. The claim happens inside the withdraw
// mutex and is released if the tx reverts, so a concurrent replay can't double-settle.
const consumedSig = new Map(); // sig -> expiry unix seconds
function sigConsumed(sig) {
  const exp = consumedSig.get(sig);
  if (exp === undefined) return false;
  if (exp < Math.floor(Date.now() / 1000)) { consumedSig.delete(sig); return false; }
  return true;
}
function pruneSigs() {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, exp] of consumedSig) if (exp < now) consumedSig.delete(k);
}

// In-memory revenue ledger. The SOURCE OF TRUTH is on chain (StreamPay withdrawals);
// this is just a convenience cache so /stats and the dashboard render instantly.
const ledger = { totalUUSDC: 0n, byArticle: {}, settlements: [] };
function record(articleId, n, vested, txHash) {
  ledger.totalUUSDC += vested;
  ledger.byArticle[articleId] = (ledger.byArticle[articleId] || 0n) + vested;
  ledger.settlements.unshift({
    article: articleId, paragraph: n, usdc: usd(vested),
    tx: txHash, explorer: `${EXPLORER}/tx/${txHash}`, at: new Date().toISOString(),
  });
  if (ledger.settlements.length > 100) ledger.settlements.pop();
}

// x402 payment requirements (HTTP 402 standard, v1). We speak x402 as the discovery
// envelope and advertise a `streampay` scheme inside `accepts` — x402's `scheme` field is
// the designed extension point ("exact"/EIP-3009 is just one scheme), and a paragraph is
// pay-per-second-of-reading, which a one-shot transfer can't express. Any x402-aware client
// can read these terms; the StreamPay specifics ride in `extra`. `maxAmountRequired` is in
// atomic USDC (6 decimals), per the x402 spec.
function x402Accept(articleId, resource, atomicAmount) {
  return {
    scheme: "streampay",
    network: "arc-testnet",
    maxAmountRequired: String(atomicAmount),
    resource,
    description: `One paragraph of "${ARTICLES[articleId].title}", released as USDC vests on the stream`,
    mimeType: "application/json",
    payTo: SERVER_ADDR,
    maxTimeoutSeconds: SIG_TTL_SECS,
    asset: USDC,
    extra: {
      settlementContract: STREAM_PAY,
      chainId: CHAIN_ID,
      pricing: `${PER_WORD_UUSDC} micro-USDC per word, floored at ${MIN_SETTLE_UUSDC} micro-USDC per paragraph (dust floor), pulled per paragraph as it vests`,
      instructions: `Open a StreamPay stream to ${SERVER_ADDR}, then GET ${resource}?stream=<id> with headers x-lp-ts: <unix> and x-lp-sig: <owner personal_sign of the access message>.`,
      ownerAuth: { messageFormat: "Lepton Press access\\nstream: <id>\\nparagraph: <n>\\nts: <unix>", headers: ["x-lp-ts", "x-lp-sig"], ttlSecs: SIG_TTL_SECS, singleUse: true },
    },
  };
}
function x402Terms(articleId, resource, atomicAmount) {
  return { x402Version: 1, accepts: [x402Accept(articleId, resource, atomicAmount)] };
}

function toc(articleId) {
  const a = ARTICLES[articleId];
  const total = a.paragraphs.reduce((s, p) => s + effectivePrice(p), 0n);
  return {
    id: articleId,
    title: a.title,
    author: a.author,
    paragraphs: a.paragraphs.map((p, i) => ({
      n: i,
      words: wordCount(p),
      priceUSDC: usd(effectivePrice(p)),
      preview: p.slice(0, 60) + "…",
      locked: true,
    })),
    totalPriceUSDC: usd(total),
    x402: x402Terms(articleId, `/article/${articleId}`, total),
  };
}

function send(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extraHeaders });
  res.end(JSON.stringify(obj, null, 2));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  // GET /stats  — creator dashboard feed
  if (parts[0] === "stats") {
    return send(res, 200, {
      publisher: SERVER_ADDR,
      totalRevenueUSDC: usd(ledger.totalUUSDC),
      byArticle: Object.fromEntries(Object.entries(ledger.byArticle).map(([k, v]) => [k, usd(v)])),
      recentSettlements: ledger.settlements.slice(0, 20),
    });
  }

  // GET /article/:id  — table of contents (free)
  if (parts[0] === "article" && parts.length === 2) {
    if (!ARTICLES[parts[1]]) return send(res, 404, { error: "no_such_article" });
    return send(res, 200, toc(parts[1]));
  }

  // GET /article/:id/p/:n  — a single paragraph (paywalled)
  if (parts[0] === "article" && parts[2] === "p" && parts.length === 4) {
    const articleId = parts[1];
    const n = Number(parts[3]);
    const a = ARTICLES[articleId];
    if (!a || !Number.isInteger(n) || n < 0 || n >= a.paragraphs.length)
      return send(res, 404, { error: "no_such_paragraph" });

    const text = a.paragraphs[n];
    const price = paragraphPrice(text);
    const resource = `/article/${articleId}/p/${n}`;
    const streamId = url.searchParams.get("stream");

    if (!streamId) {
      return send(res, 402, {
        error: "payment_required",
        article: articleId, paragraph: n,
        priceUSDC: usd(effectivePrice(text)),
        x402: x402Terms(articleId, resource, effectivePrice(text)),
      }, { "WWW-Authenticate": `x402 scheme="streampay", settlementContract="${STREAM_PAY}", payTo="${SERVER_ADDR}", asset="${USDC}"` });
    }

    // Verify the stream on chain.
    let st;
    try { st = await sp.get(streamId); }
    catch { return send(res, 402, { error: "payment_required", reason: "stream_not_found", x402: x402Terms(articleId, resource, price) }); }
    const active = Number(st.status) === 1;
    if (!active || st.recipient.toLowerCase() !== SERVER_ADDR.toLowerCase())
      return send(res, 402, { error: "payment_required", reason: "stream_inactive_or_wrong_recipient", x402: x402Terms(articleId, resource, price) });

    // Caller↔stream binding. Stream ids are sequential and enumerable, so without proving
    // ownership anyone could pass someone else's ?stream=<id> and have us withdraw THEIR
    // vested USDC and serve THEM the text — draining the real funder. Require a fresh
    // signature from st.sender over a stream-scoped message before spending the stream.
    // ts + sig travel in HEADERS (not the URL), so the signature never lands in access logs,
    // proxy logs, or the Referer header. The signed message still binds stream + paragraph + ts.
    const ts = Number(req.headers["x-lp-ts"]);
    const sig = req.headers["x-lp-sig"];
    if (!sig || !Number.isInteger(ts))
      return send(res, 403, { error: "forbidden", reason: "owner_signature_required",
        auth: "send headers x-lp-ts (unix seconds) and x-lp-sig (personal_sign of the access message)",
        authMessageFormat: accessMessage("<streamId>", "<paragraph>", "<unixSeconds>"), ttlSecs: SIG_TTL_SECS });
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SIG_TTL_SECS)
      return send(res, 403, { error: "forbidden", reason: "stale_signature", ttlSecs: SIG_TTL_SECS });
    pruneSigs();
    if (sigConsumed(sig)) // already settled a paragraph — single-use, can't be replayed
      return send(res, 403, { error: "forbidden", reason: "replayed_signature" });
    let signer;
    try { signer = ethers.verifyMessage(accessMessage(streamId, n, ts), sig); }
    catch { return send(res, 403, { error: "forbidden", reason: "bad_signature" }); }
    if (signer.toLowerCase() !== st.sender.toLowerCase())
      return send(res, 403, { error: "forbidden", reason: "not_stream_owner" });

    // Gas-floor: must cover both the paragraph price AND the dust floor, so we never settle
    // less than it costs the publisher to settle.
    const need = price > MIN_SETTLE_UUSDC ? price : MIN_SETTLE_UUSDC;
    const vested = await sp.recipientBalance(streamId);
    if (vested < need) {
      console.log(`402  ${articleId}#${n} below settle floor vested=$${usd(vested)} < $${usd(need)}`);
      return send(res, 402, {
        error: "payment_required", reason: "insufficient_vested_balance",
        article: articleId, paragraph: n, priceUSDC: usd(price), minSettleUSDC: usd(need), vestedUSDC: usd(vested),
        x402: x402Terms(articleId, resource, need),
      });
    }

    // Settle: pull EXACTLY the paragraph price (`need`), not all that has vested. StreamPay's
    // withdraw(id, amount) honours an exact amount (amount=0 would mean "all"), so the on-chain
    // settlement equals the advertised per-paragraph price — the TOC priceUSDC and the Withdrawn
    // event match, and the README figure is literally what moves. The streamed-but-unwithdrawn
    // remainder stays in the stream and is swept to the publisher (or reclaimed by the reader)
    // at cancel. Arc block.timestamp is non-monotonic, so available can dip below `need` between
    // the read and mining and the tx reverts — a transient, not a fault: answer 402 and retry.
    let rc, settled = need;
    try {
      // Serialized: only one withdraw from this wallet is in flight at a time (nonce safety).
      rc = await serializeWithdraw(async () => {
        // Claim the signature INSIDE the lock so a concurrent replay can't double-settle; the
        // re-check closes the race between the early check and here. Released below on revert.
        if (sigConsumed(sig)) { const e = new Error("replayed"); e.replayed = true; throw e; }
        consumedSig.set(sig, Math.floor(Date.now() / 1000) + SIG_TTL_SECS);
        try {
          const tx = await sp.withdraw(streamId, need);
          const r = await tx.wait(1, WITHDRAW_TIMEOUT_MS); // times out instead of hanging the chain
          if (r.status !== 1) throw new Error("withdraw reverted");
          return r;
        } catch (err) {
          consumedSig.delete(sig); // transient (non-monotonic dip / timeout) — let the reader retry
          throw err;
        }
      });
      // Confirm against the chain: record the exact amount the Withdrawn event reports (== need).
      for (const lg of rc.logs) {
        try {
          const p = sp.interface.parseLog(lg);
          if (p && p.name === "Withdrawn") { settled = p.args.amount; break; }
        } catch {}
      }
    } catch (e) {
      if (e.replayed) return send(res, 403, { error: "forbidden", reason: "replayed_signature" });
      console.log(`402  ${articleId}#${n} settle failed (${e.shortMessage || e.message}) — retry`);
      return send(res, 402, { error: "payment_required", reason: "settlement_reverted_retry", x402: x402Terms(articleId, resource, price) });
    }

    record(articleId, n, settled, rc.hash);
    console.log(`200  ${articleId}#${n} released, settled $${usd(settled)}  tx ${rc.hash}`);
    return send(res, 200, {
      ok: true,
      article: articleId, paragraph: n,
      text,
      payment: { settledUSDC: usd(settled), settlementTx: rc.hash, explorer: `${EXPLORER}/tx/${rc.hash}` },
    });
  }

  return send(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(`500  ${e.shortMessage || e.message}`);
    try { send(res, 500, { error: "server_error", detail: e.shortMessage || e.message }); } catch {}
  });
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.shortMessage || e?.message || e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.shortMessage || e?.message || e));

server.listen(PORT, () => {
  console.log(`Lepton Press publisher on :${PORT}`);
  console.log(`  payTo (publisher)  ${SERVER_ADDR}`);
  console.log(`  StreamPay          ${STREAM_PAY}`);
  console.log(`  pricing            ${PER_WORD_UUSDC} µUSDC/word`);
  console.log(`  articles           ${Object.keys(ARTICLES).join(", ")}`);
});
