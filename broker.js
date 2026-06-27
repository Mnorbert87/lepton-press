#!/usr/bin/env node
/**
 * Broker agent for Lepton Press — a two-hop nanopayment value chain on Arc.
 *
 * This is the agentic economy in miniature: software paying software, twice, no human in
 * the loop. A research-broker agent:
 *
 *   HOP 1 (broker → publisher):  the broker reads Lepton Press paragraph by paragraph,
 *                                paying the publisher per paragraph over StreamPay and
 *                                stopping when the content stops answering its question.
 *   SYNTHESIZE:                  it distills the paragraphs it paid for into one answer.
 *   HOP 2 (consumer → broker):   a downstream consumer agent pays the broker for that
 *                                answer over a second StreamPay stream. The broker only
 *                                profits if its markup beats what it paid upstream.
 *
 * Every settlement on both hops is a real Arc tx. The broker's margin is the whole point:
 * it must buy cheaply and sell dearer, or it loses money — per-read economics, end to end.
 *
 * Env:
 *   BROKER_PRIVATE_KEY    the broker's testnet key (reads + receives)   [required]
 *   CONSUMER_PRIVATE_KEY  the downstream consumer's testnet key (pays the broker) [required]
 *   RPC_URL / USDC / STREAM_PAY                                         [Arc testnet defaults]
 *   SERVER_URL            Lepton publisher base URL                     [default http://localhost:4030]
 *   ARTICLE               article id to read                           [default arc-nanopayments]
 *   QUESTION              the consumer's question (drives the read)     [default below]
 *   READ_BUDGET_USDC      broker's upstream budget                      [default 0.02]
 *   MARKUP                broker's markup over cost (0.5 = +50%)        [default 0.6]
 *   GIVE_UP               stop after N off-topic paragraphs            [default 2]
 *   ANTHROPIC_API_KEY     enables the Claude judge + synthesis         [optional; heuristic if unset]
 *   JUDGE_MODEL           model id                                     [default claude-opus-4-8]
 *   RUN_LOG               path to record the value-chain run as JSON    [optional]
 */
import { ethers } from "ethers";
import { writeFileSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const EXPLORER = "https://testnet.arcscan.app";
const USDC = process.env.USDC || "0x3600000000000000000000000000000000000000";
const STREAM_PAY = process.env.STREAM_PAY || "0x505739d33D85AD85D0f9eeE64856309782382450";
const SERVER_URL = process.env.SERVER_URL || "http://localhost:4030";
const ARTICLE = process.env.ARTICLE || "arc-nanopayments";
const QUESTION = process.env.QUESTION || "why can card networks not serve micropayments, and what changes it";
const READ_BUDGET = BigInt(Math.round(Number(process.env.READ_BUDGET_USDC || 0.02) * 1e6));
const MARKUP = Number(process.env.MARKUP || 0.6);
const GIVE_UP = Number(process.env.GIVE_UP || 2);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-opus-4-8";
const RUN_LOG = process.env.RUN_LOG;

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const SP = [
  "function createStream(address,uint256,uint64,uint64,string) returns (uint256)",
  "function recipientBalance(uint256) view returns (uint256)",
  "function senderBalance(uint256) view returns (uint256)",
  "function withdraw(uint256,uint256)",
  "function get(uint256) view returns (tuple(address sender,address recipient,uint256 deposit,uint256 withdrawn,uint64 start,uint64 stop,uint8 status))",
  "function nextId() view returns (uint256)",
  "function cancel(uint256)",
  "event Created(uint256 indexed id, address indexed sender, address indexed recipient, uint256 deposit, uint64 start, uint64 stop, string memo)",
  "event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount)",
];

const usd = (v) => (Number(v) / 1e6).toFixed(6);
const uu = (s) => BigInt(Math.round(Number(s) * 1e6));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const accessMessage = (streamId, n, ts) => `Lepton Press access\nstream: ${streamId}\nparagraph: ${n}\nts: ${ts}`;

async function fetchTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// Relevance heuristic (fallback for the judge). Same model as the reader.
function relevance(task, text) {
  const stop = new Set(["the","a","an","and","or","of","to","in","is","it","that","for","on","as","not","be","by","this","with","are","was","why","how","what","when","where","which","who","can","does","do","will","its","their","than","then","but","into","at","from","you","your","our","they","them"]);
  const stem = (w) => w.replace(/ies$/, "y").replace(/(es|s)$/, "");
  const toks = (s) => [...new Set((s.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length > 2 && !stop.has(w)).map(stem))];
  const q = toks(task), p = new Set(toks(text));
  if (!q.length) return 0;
  let hit = 0;
  for (const w of q) { if (p.has(w)) { hit++; continue; } for (const t of p) if ((w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t))) { hit++; break; } }
  return hit / q.length;
}

const JUDGE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    relevance: { type: "number", description: "0.0–1.0: how much this paragraph advances the question" },
    worth_paying: { type: "boolean", description: "true if buying the next paragraph is still likely to pay off" },
    reason: { type: "string", description: "one short clause" },
  },
  required: ["relevance", "worth_paying", "reason"],
};
async function llmJudge(task, text, soFar) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL, max_tokens: 256,
        system: "You are the relevance judge for an autonomous research broker that pays per paragraph in USDC. Judge strictly whether the paragraph advances the question and whether continuing is worth paying for.",
        messages: [{ role: "user", content: `QUESTION: ${task}\nPARAGRAPHS ALREADY PAID FOR: ${soFar}\n\nPARAGRAPH JUST BOUGHT:\n${text}` }],
        output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) return null;
    const out = JSON.parse(block.text);
    const rel = Math.max(0, Math.min(1, Number(out.relevance)));
    return { rel: Number.isFinite(rel) ? rel : 0, worth: out.worth_paying !== false, reason: String(out.reason || "").slice(0, 120) };
  } catch { return null; }
}

// Distill the paid-for paragraphs into one answer. With a key, Claude writes it; without,
// an extractive fallback (the lead sentence of each paid paragraph) keeps it self-contained.
async function synthesize(question, paras) {
  const extractive = paras.map((p) => p.text.split(/(?<=[.!?])\s/)[0]).join(" ");
  if (!ANTHROPIC_KEY) return { text: extractive, mode: "extractive" };
  try {
    const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL, max_tokens: 400,
        system: "You are a research broker. Answer the question in 2-3 sentences using ONLY the paragraphs the broker paid for. Be precise and self-contained.",
        messages: [{ role: "user", content: `QUESTION: ${question}\n\nPAID PARAGRAPHS:\n${paras.map((p, i) => `[${i}] ${p.text}`).join("\n\n")}` }],
      }),
    });
    if (!r.ok) return { text: extractive, mode: "extractive" };
    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === "text");
    return block ? { text: block.text.trim(), mode: "llm", model: JUDGE_MODEL } : { text: extractive, mode: "extractive" };
  } catch { return { text: extractive, mode: "extractive" }; }
}

async function settle(label, txPromise) {
  const tx = await txPromise;
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error(`${label} reverted`);
  log(`   ✓ ${label}  ${EXPLORER}/tx/${rc.hash}`);
  return rc;
}

// Open a stream and read its id from the Created event in the receipt — not from
// nextId()-1, which races with any concurrent createStream on the shared contract.
async function openStream(sp, label, ...args) {
  const rc = await settle(label, sp.createStream(...args));
  for (const lg of rc.logs) {
    try { const p = sp.interface.parseLog(lg); if (p && p.name === "Created") return p.args.id; } catch {}
  }
  throw new Error("Created event not found in receipt");
}

async function main() {
  const bpk = process.env.BROKER_PRIVATE_KEY;
  const cpk = process.env.CONSUMER_PRIVATE_KEY;
  if (!bpk) throw new Error("Set BROKER_PRIVATE_KEY.");
  if (!cpk) throw new Error("Set CONSUMER_PRIVATE_KEY.");

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const broker = new ethers.Wallet(bpk, provider);
  const consumer = new ethers.Wallet(cpk, provider);
  const usdcB = new ethers.Contract(USDC, ERC20, broker);
  const usdcC = new ethers.Contract(USDC, ERC20, consumer);
  const spB = new ethers.Contract(STREAM_PAY, SP, broker);   // broker signs hop-1 (pay) + hop-2 withdraw
  const spC = new ethers.Contract(STREAM_PAY, SP, consumer); // consumer signs hop-2 (pay)

  log(`\n🧩 Broker agent — a two-hop nanopayment value chain on Arc`);
  log(`   broker    ${broker.address}`);
  log(`   consumer  ${consumer.address}`);
  log(`   question  "${QUESTION}"`);
  log(`   synthesis ${ANTHROPIC_KEY ? `LLM (${JUDGE_MODEL})` : "extractive (set ANTHROPIC_API_KEY for Claude)"}\n`);

  const out = {
    question: QUESTION, article: ARTICLE,
    broker: broker.address, consumer: consumer.address,
    judge: ANTHROPIC_KEY ? { mode: "llm", model: JUDGE_MODEL } : { mode: "heuristic" },
    explorer: `${EXPLORER}/tx`, hop1: { paragraphs: [] },
  };

  // ─ HOP 1: broker buys from the publisher ────────────────────────────────────
  log(`[HOP 1] broker → publisher — buying paragraphs that answer the question`);
  const tocRes = await fetchTimeout(`${SERVER_URL}/article/${ARTICLE}`);
  if (tocRes.status !== 200) throw new Error(`TOC failed: ${tocRes.status}`);
  const toc = await tocRes.json();
  const terms = (toc.x402?.accepts || []).find((a) => a.scheme === "streampay") || toc.x402?.accepts?.[0];
  const payTo = ethers.getAddress(terms.payTo);
  out.publisher = payTo;
  log(`   "${toc.title}" — publisher ${payTo}`);

  if ((await usdcB.allowance(broker.address, STREAM_PAY)) < READ_BUDGET) await settle("broker approve USDC", usdcB.approve(STREAM_PAY, ethers.MaxUint256));
  const now1 = BigInt(Math.floor(Date.now() / 1000));
  const sid1 = await openStream(spB, "createStream broker→publisher", payTo, READ_BUDGET, now1, now1 + 45n, `lepton-press:${ARTICLE}`);
  out.hop1.streamId = sid1.toString();
  log(`   stream #${sid1} opened ($${usd(READ_BUDGET)} budget)`);

  let cost = 0n, cold = 0, paid = [];
  for (const para of toc.paragraphs) {
    const price = uu(para.priceUSDC);
    if (cost + price > READ_BUDGET) { log(`   · budget reached — stop.`); break; }
    const ts = Math.floor(Date.now() / 1000);
    const sig = await broker.signMessage(accessMessage(sid1, para.n, ts));
    const headers = { "x-lp-ts": String(ts), "x-lp-sig": sig }; // sig in headers, not the URL
    let body, status = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await fetchTimeout(`${SERVER_URL}/article/${ARTICLE}/p/${para.n}?stream=${sid1}`, { headers });
        status = r.status; body = await r.json();
        if (status === 200) break;
      } catch { status = 0; }
      await sleep(700);
    }
    if (status !== 200) { log(`   ¶${para.n}: could not settle — stop.`); break; }
    cost += uu(body.payment.settledUSDC);
    const verdict = await llmJudge(QUESTION, body.text, paid.length);
    const rel = verdict ? verdict.rel : relevance(QUESTION, body.text);
    const worth = verdict ? verdict.worth : rel >= 0.12;
    log(`   ¶${para.n}: paid $${body.payment.settledUSDC}  relevance ${(rel * 100).toFixed(0)}%`);
    paid.push({ n: para.n, paidUSDC: body.payment.settledUSDC, tx: body.payment.settlementTx, explorer: body.payment.explorer, relevance: Math.round(rel * 100), text: body.text });
    if (!worth) { cold++; if (cold >= GIVE_UP) { log(`   · task saturated — stop.`); break; } } else cold = 0;
  }
  out.hop1.paragraphs = paid;
  // Cancel reclaims the unspent budget — and on StreamPay also pays the recipient the final
  // vested-but-unwithdrawn slice. So the TRUE cost (what the publisher actually received) is
  // only known AFTER the cancel: read the stream's `withdrawn` then. Using on-chain truth
  // here means the reported margin can never overstate the broker's real spend.
  const st1 = await spB.get(sid1);
  if (Number(st1.status) === 1) await settle(`cancel stream #${sid1} (reclaim)`, spB.cancel(sid1));
  cost = (await spB.get(sid1)).withdrawn;
  out.hop1.costUSDC = usd(cost);
  log(`   bought ${paid.length} paragraph(s), cost $${usd(cost)} (on-chain, incl. cancel settlement)`);

  // ─ SYNTHESIZE ───────────────────────────────────────────────────────────────
  log(`\n[SYNTHESIZE] distilling the answer from what the broker paid for`);
  const answer = await synthesize(QUESTION, paid);
  out.answer = answer.text;
  out.synthesis = { mode: answer.mode, model: answer.model || null };
  log(`   (${answer.mode}) ${answer.text.slice(0, 120)}…`);

  // ─ HOP 2: consumer buys the answer from the broker ──────────────────────────
  const price = (cost * BigInt(Math.round((1 + MARKUP) * 1000))) / 1000n; // cost × (1+markup)
  out.hop2 = { priceUSDC: usd(price), markup: MARKUP };
  log(`\n[HOP 2] consumer → broker — selling the answer for $${usd(price)} (cost $${usd(cost)} + ${Math.round(MARKUP * 100)}%)`);
  if ((await usdcC.allowance(consumer.address, STREAM_PAY)) < price) await settle("consumer approve USDC", usdcC.approve(STREAM_PAY, ethers.MaxUint256));
  const now2 = BigInt(Math.floor(Date.now() / 1000));
  // short window so the full price vests fast; the broker pulls it, then delivers the answer
  const sid2 = await openStream(spC, "createStream consumer→broker", broker.address, price, now2, now2 + 10n, `lepton-press:answer:${ARTICLE}`);
  out.hop2.streamId = sid2.toString();
  // wait for the price to vest, then the broker withdraws (real tx) and "delivers"
  let got = 0n, sellTx = null;
  for (let attempt = 0; attempt < 25; attempt++) {
    const vested = await spB.recipientBalance(sid2);
    if (vested >= price) {
      const rc = await settle(`broker withdraw (sell)`, spB.withdraw(sid2, 0n));
      for (const lg of rc.logs) { try { const p = spB.interface.parseLog(lg); if (p && p.name === "Withdrawn") { got = p.args.amount; break; } } catch {} }
      sellTx = rc.hash;
      break;
    }
    await sleep(700);
  }
  if (!sellTx) {
    // symmetry with hop 1: never leave the consumer's stream dangling on failure
    try { const st2 = await spC.get(sid2); if (Number(st2.status) === 1) await settle(`cancel consumer stream #${sid2} (reclaim)`, spC.cancel(sid2)); } catch {}
    throw new Error("consumer payment did not vest in time");
  }
  out.hop2.settledUSDC = usd(got);
  out.hop2.tx = sellTx;
  out.hop2.explorer = `${EXPLORER}/tx/${sellTx}`;
  log(`   broker received $${usd(got)} for the answer`);

  const profit = got - cost;
  out.economics = { costUSDC: usd(cost), revenueUSDC: usd(got), profitUSDC: usd(profit), markup: MARKUP };
  log(`\n✅ value chain closed — broker paid $${usd(cost)} upstream, earned $${usd(got)} downstream, profit $${usd(profit)}.`);
  log(`   content → broker → consumer, ${paid.length + 1} on-chain settlements, 0 humans.\n`);

  if (RUN_LOG) { writeFileSync(RUN_LOG, JSON.stringify(out, null, 2)); log(`   📝 value-chain run recorded → ${RUN_LOG}\n`); }
}

main().catch((e) => { console.error("broker error:", e.shortMessage || e.message || e); process.exit(1); });
