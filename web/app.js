import { ethers } from "https://esm.sh/ethers@6.13.4";

// ── Config ──────────────────────────────────────────────────────────────────
// Override any of these with URL params, e.g. ?publisher=0x…&start=0
const q = new URLSearchParams(location.search);
const CFG = {
  rpc:       q.get("rpc")       || "https://rpc.testnet.arc.network",
  chainId:   5042002,
  streamPay: q.get("streampay") || "0x505739d33D85AD85D0f9eeE64856309782382450",
  // The publisher (StreamPay recipient) whose revenue we display. Defaults to the demo
  // publisher so the bare URL works out of the box; override with ?publisher=0x….
  publisher: q.get("publisher") || "0xed13AA20701F503304bADB7697cbFD4d0C952Acf",
  // Arc RPC rejects eth_getLogs over wide ranges, so we scan from startBlock to head in
  // CHUNK windows. Defaults to the block just before the demo's first stream so the full
  // history shows cheaply; override with ?start=<block> or ?lookback=<blocks>.
  startBlock: q.get("start") ? Number(q.get("start")) : 48947500,
  lookback:  q.get("lookback") ? Number(q.get("lookback")) : 30000, // ~5h of Arc blocks
  explorer:  "https://testnet.arcscan.app",
};
const CHUNK = 9000;            // max safe eth_getLogs span on this RPC
const MAX_CHUNKS = 60;         // hard cap so a stale ?start= can't hammer the RPC
const REFRESH_MS = 12000;

const usd = (v) => "$" + (Number(v) / 1e6).toFixed(6);
const usdNum = (v) => (Number(v) / 1e6);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const $ = (id) => document.getElementById(id);
// The article label comes from the stream memo, which any address can set on-chain.
// Escape it before it touches innerHTML so a crafted memo can't inject markup.
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const provider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId);
const sp = new ethers.Contract(CFG.streamPay, [
  "event Created(uint256 indexed id, address indexed sender, address indexed recipient, uint256 deposit, uint64 start, uint64 stop, string memo)",
  "event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount)",
  "event Cancelled(uint256 indexed id, address indexed by, uint256 toRecipient, uint256 toSender)",
], provider);

$("m-pub").textContent = CFG.publisher === ethers.ZeroAddress ? "(set ?publisher=0x…)" : short(CFG.publisher);
$("m-sp").textContent = short(CFG.streamPay);
$("m-sp").href = `${CFG.explorer}/address/${CFG.streamPay}`;

const articleOf = (memo) => (memo && memo.startsWith("lepton-press:")) ? memo.slice("lepton-press:".length) : (memo || "—");
const titleCase = (slug) => slug === "—" ? slug : slug.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());

// ── Animated count-up (ease-out), remembers last value to animate deltas ─────
const _last = {};
function countTo(id, to, fmt) {
  const el = $(id); if (!el) return;
  const from = _last[id] ?? 0; _last[id] = to;
  if (from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 850;
  function step(t) {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);            // ease-out cubic
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Sparkline: cumulative revenue across settlements in chronological order ──
function drawSpark(points) {
  const svg = $("spark"); const W = 400, H = 108, pad = 6;
  // clear everything except <defs>
  [...svg.querySelectorAll(":not(defs)")].forEach(n => n.remove());
  const NS = "http://www.w3.org/2000/svg";
  if (points.length < 2) return;
  const max = points[points.length - 1] || 1;
  const xs = (i) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const ys = (v) => H - pad - (v / max) * (H - pad * 2);
  // baseline grid
  const g = document.createElementNS(NS, "line");
  g.setAttribute("class", "grid"); g.setAttribute("x1", pad); g.setAttribute("x2", W - pad);
  g.setAttribute("y1", H - pad); g.setAttribute("y2", H - pad); svg.appendChild(g);
  let d = `M ${xs(0)} ${ys(points[0])}`;
  for (let i = 1; i < points.length; i++) d += ` L ${xs(i)} ${ys(points[i])}`;
  const area = document.createElementNS(NS, "path");
  area.setAttribute("class", "area");
  area.setAttribute("d", `${d} L ${xs(points.length - 1)} ${H - pad} L ${xs(0)} ${H - pad} Z`);
  svg.appendChild(area);
  const line = document.createElementNS(NS, "path");
  line.setAttribute("class", "line"); line.setAttribute("d", d); svg.appendChild(line);
  // animate the stroke drawing in
  const len = line.getTotalLength();
  line.style.strokeDasharray = len; line.style.strokeDashoffset = len;
  line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", xs(points.length - 1)); dot.setAttribute("cy", ys(points[points.length - 1])); dot.setAttribute("r", 3.6);
  svg.appendChild(dot);
}

// Walk startBlock→head in CHUNK windows; the RPC rejects anything wider.
async function scan(filter, fromBlock, toBlock) {
  const out = [];
  for (let from = fromBlock, n = 0; from <= toBlock && n < MAX_CHUNKS; from += CHUNK + 1, n++) {
    const to = Math.min(from + CHUNK, toBlock);
    out.push(...await sp.queryFilter(filter, from, to));
  }
  return out;
}

async function load() {
  if (CFG.publisher === ethers.ZeroAddress) {
    $("foot").innerHTML = `<span class="err">No publisher set.</span> Append <code>?publisher=0xYOUR_PUBLISHER_ADDRESS</code> to the URL to read its on-chain revenue.`;
    return;
  }
  try {
    const recipient = ethers.getAddress(CFG.publisher);
    const head = await provider.getBlockNumber();
    const from = CFG.startBlock != null ? CFG.startBlock : Math.max(0, head - CFG.lookback);

    // Map streamId → article, from Created events to this publisher (memo carries the article).
    // These ids are exactly this publisher's streams — used to attribute cancel-time sweeps,
    // whose Cancelled event is not indexed by recipient.
    const created = await scan(sp.filters.Created(null, null, recipient), from, head);
    const article = new Map();
    const myIds = new Set();
    for (const e of created) { const id = e.args.id.toString(); article.set(id, articleOf(e.args.memo)); myIds.add(id); }

    // The publisher is paid two on-chain ways, and honest revenue is the sum of both:
    //  1. Withdrawn — metered per-paragraph reads the publisher pulled as the agent read.
    //  2. Cancelled.toRecipient — the streamed-but-unwithdrawn balance swept to the publisher
    //     when a stream is cancelled (time vested past the last paragraph pull). Counting only
    //     (1) under-reports what the address actually received; counting only the sweep would
    //     hide the metering. We show both, broken out, and the total matches the address.
    const paid = await scan(sp.filters.Withdrawn(null, recipient), from, head); // recipient indexed → cheap
    const cancelled = await scan(sp.filters.Cancelled(), from, head);           // not indexed by recipient
    const swept = cancelled.filter(e => myIds.has(e.args.id.toString()) && e.args.toRecipient > 0n);

    // One revenue ledger: paragraph reads + disengagement settlements, chronological.
    const ev = [];
    for (const e of paid)  ev.push({ kind: "read",   id: e.args.id.toString(), amt: e.args.amount,       tx: e.transactionHash, block: e.blockNumber, index: e.index });
    for (const e of swept) ev.push({ kind: "settle", id: e.args.id.toString(), amt: e.args.toRecipient,  tx: e.transactionHash, block: e.blockNumber, index: e.index });
    ev.sort((a, b) => a.block - b.block || a.index - b.index);

    let metered = 0n, sweep = 0n; const byArticle = {}; const readers = new Set();
    const cumul = []; let running = 0n;
    for (const e of ev) {
      if (e.kind === "read") metered += e.amt; else sweep += e.amt;
      running += e.amt; cumul.push(usdNum(running));
      const art = article.get(e.id) || "—";
      byArticle[art] = (byArticle[art] || 0n) + e.amt;
      readers.add(e.id);
    }
    const total = metered + sweep;
    const rows = [...ev].reverse(); // newest first for the table

    countTo("c-rev", usdNum(total), v => v.toFixed(6));
    countTo("c-set", paid.length, v => Math.round(v).toLocaleString());
    countTo("c-rdr", readers.size, v => Math.round(v).toLocaleString());
    $("c-set2").textContent = paid.length.toLocaleString();
    $("c-rdr2").textContent = readers.size.toLocaleString();
    $("c-avg").textContent = paid.length ? usd(metered / BigInt(paid.length)) : "$0.000000";
    // Revenue is two on-chain components, shown co-equally so the split is self-evident and the
    // headline is the MECHANISM, not a bare number: metered per-paragraph reads + the streamed
    // time-budget swept to the publisher when the agent disengages. Both are real USDC received.
    const totalNum = usdNum(total) || 1;
    const pMet = Math.round((usdNum(metered) / totalNum) * 1000) / 10;
    const pSwp = Math.round((usdNum(sweep) / totalNum) * 1000) / 10;
    $("rb-metered").textContent = usd(metered);
    $("rb-sweep").textContent   = usd(sweep);
    $("rb-bar-metered").style.width = pMet + "%";
    $("rb-bar-sweep").style.width   = pSwp + "%";
    $("rb-pct-metered").textContent = pMet + "%";
    $("rb-pct-sweep").textContent   = pSwp + "%";
    drawSpark(cumul);

    // By-article bars
    const maxA = Object.values(byArticle).reduce((m, v) => v > m ? v : m, 1n);
    const byEl = $("by-article");
    const arts = Object.entries(byArticle).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    byEl.innerHTML = arts.length ? `<table><thead><tr><th>Article</th><th style="text-align:right">Revenue</th></tr></thead><tbody>` +
      arts.map(([a, v]) => `<tr><td><span class="art">${esc(titleCase(a))}</span><div class="bar" style="width:${Number(v * 100n / maxA)}%"></div></td><td class="num">${usd(v)}</td></tr>`).join("") +
      `</tbody></table>` : `<div class="empty">No settlements yet.</div>`;

    // Recent settlements — paragraph reads and disengagement settlements, newest first.
    const kindTag = (k) => k === "settle"
      ? `<span class="kind settle">settlement</span>`
      : `<span class="kind read">read</span>`;
    const setEl = $("settlements");
    setEl.innerHTML = rows.length ? `<table><thead><tr><th>Stream</th><th>Article</th><th>Kind</th><th>Block</th><th style="text-align:right">Paid</th><th style="text-align:right">Tx</th></tr></thead><tbody>` +
      rows.slice(0, 25).map(r => `<tr><td><span class="id">#${esc(r.id)}</span></td><td><span class="art">${esc(titleCase(article.get(r.id) || "—"))}</span></td><td>${kindTag(r.kind)}</td><td><span class="id">${r.block}</span></td><td class="num">${usd(r.amt)}</td><td style="text-align:right"><a href="${CFG.explorer}/tx/${r.tx}" target="_blank" rel="noopener">${short(r.tx)}</a></td></tr>`).join("") +
      `</tbody></table>` : `<div class="empty">No settlements yet — run the reader agent against this publisher.</div>`;

    $("m-upd").textContent = new Date().toLocaleTimeString();
    $("foot").innerHTML = `<div class="colophon">Lepton Press — printed by no one, settled by everyone.</div>Read directly from Arc RPC <code>${esc(CFG.rpc)}</code> — ${created.length} stream(s) opened, ${paid.length} paragraph read(s), ${swept.length} disengagement settlement(s). This page has no server.`;
  } catch (err) {
    $("foot").innerHTML = `<div class="colophon">Lepton Press</div><span class="err">RPC error:</span> ${esc(err.shortMessage || err.message)}`;
  }
}

load();
setInterval(load, REFRESH_MS);
