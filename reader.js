#!/usr/bin/env node
/**
 * Autonomous reader agent for Lepton Press.
 *
 * It does not consume an article the way a person does. It has a TASK, a BUDGET, and a
 * STOPPING RULE, and it pays for each paragraph only while the paragraph still earns its
 * price against the task. No human in the loop, settled on Arc:
 *
 *   1. GET /article/:id            — reads the free table of contents + per-paragraph prices.
 *   2. createStream(publisher, …)  — opens a StreamPay micro-stream: its committed budget.
 *   3. for each paragraph, in order:
 *        wait until the paragraph's price has vested, GET …/p/<n>?stream=<id> (the server
 *        withdraw()s the vested USDC and returns the text), then SCORE the paragraph against
 *        the task. Keep reading while the budget holds and the text is still relevant; stop
 *        once it stops paying off (the long-tail economics made legible, transaction by tx).
 *   4. cancel(streamId)            — reclaim the unspent budget. Clean lifecycle.
 *
 * Env:
 *   AGENT_PRIVATE_KEY  reader agent's testnet key (0x…)        [required]
 *   RPC_URL / USDC / STREAM_PAY                                [Arc testnet defaults]
 *   SERVER_URL         publisher base URL                      [default http://localhost:4030]
 *   ARTICLE            article id to read                      [default arc-nanopayments]
 *   TASK               the agent's information goal            [default below]
 *   BUDGET_USDC        stream budget                           [default 0.02]
 *   STREAM_SECS        stream duration                         [default 60]
 *   GIVE_UP            stop after N low-relevance paragraphs    [default 2]
 *   ANTHROPIC_API_KEY  enables the Claude LLM relevance judge   [optional; heuristic if unset]
 *   JUDGE_MODEL        model id for the judge                   [default claude-opus-4-8]
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
const TASK = process.env.TASK || "why can card networks not serve micropayments, and what changes it";
const BUDGET = BigInt(Math.round(Number(process.env.BUDGET_USDC || 0.02) * 1e6));
const STREAM_SECS = Number(process.env.STREAM_SECS || 60);
const GIVE_UP = Number(process.env.GIVE_UP || 2);
// The agent's mind. When ANTHROPIC_API_KEY is set the reader scores each paragraph with a
// real LLM judge (Claude) that decides, per transaction, whether the next paragraph still
// earns its price against the task — genuine autonomy, not a keyword heuristic. With no key
// it falls back to the inspectable word-overlap model below, so the demo stays self-contained.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "claude-opus-4-8";
// When set, the reader records a structured JSON log of this run (every paid paragraph with
// its judge verdict and real settlement tx) to this path. That file is what the dashboard's
// interactive replay plays back — real, verifiable data, captured once, replayed for free.
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
  "function get(uint256) view returns (tuple(address sender,address recipient,uint256 deposit,uint256 withdrawn,uint64 start,uint64 stop,uint8 status))",
  "function nextId() view returns (uint256)",
  "function cancel(uint256)",
];

const usd = (v) => (Number(v) / 1e6).toFixed(6);
const uu = (s) => BigInt(Math.round(Number(s) * 1e6)); // "0.000130" -> micro-USDC
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
// Stream- and paragraph-scoped access challenge — must match the publisher byte-for-byte.
const accessMessage = (streamId, n, ts) => `Lepton Press access\nstream: ${streamId}\nparagraph: ${n}\nts: ${ts}`;

// fetch with a hard timeout — a hung publisher or judge must not freeze the reader on one
// paragraph while the stream keeps vesting (budget waste). Aborts after ms; caller retries.
async function fetchTimeout(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

// The agent's relevance model. Deliberately simple and inspectable: content-word overlap
// between the task and the paragraph, robust to plural/morphological variants. Question words
// ("why/what/how/can") carry no topic signal, so they are dropped and only the content words
// (card, network, micropayment, change…) decide. A real agent swaps this for an embedding
// score or an LLM judge — the payment loop is identical.
function relevance(task, text) {
  const stop = new Set([
    "the","a","an","and","or","of","to","in","is","it","that","for","on","as","not","be","by",
    "this","with","are","was","why","how","what","when","where","which","who","can","does","do",
    "will","its","their","than","then","but","into","at","from","you","your","our","they","them",
  ]);
  // crude stemmer: fold plurals so "changes"≈"change", "networks"≈"network", "micropayments"≈"micropayment".
  const stem = (w) => w.replace(/ies$/, "y").replace(/(es|s)$/, "");
  const toks = (s) => [...new Set((s.toLowerCase().match(/[a-z]+/g) || []).filter((w) => w.length > 2 && !stop.has(w)).map(stem))];
  const q = toks(task), p = new Set(toks(text));
  if (!q.length) return 0;
  let hit = 0;
  for (const w of q) {
    if (p.has(w)) { hit++; continue; }
    // prefix match catches the variants the stemmer misses ("settle" ~ "settlement").
    for (const t of p) if ((w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t))) { hit++; break; }
  }
  return hit / q.length;
}

// The LLM judge. Given the agent's task and a freshly-bought paragraph, Claude returns a
// relevance score and an explicit "is the next paragraph still worth its price" decision —
// the buyer-side intelligence that makes per-read economics legible. Single stateless call,
// no thinking (latency matters: this runs once per paid paragraph), structured JSON out.
// Returns null on any failure so the caller can fall back to the heuristic.
const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    relevance: { type: "number", description: "0.0–1.0: how much this paragraph advances the task" },
    worth_paying: { type: "boolean", description: "true if buying the next paragraph is still likely to pay off for the task" },
    reason: { type: "string", description: "one short clause explaining the call" },
  },
  required: ["relevance", "worth_paying", "reason"],
};
async function llmJudge(task, text, soFar) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const r = await fetchTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 256,
        system:
          "You are the relevance judge for an autonomous reading agent that pays per paragraph " +
          "in USDC. Each paragraph costs real money, so judge strictly whether it advances the " +
          "agent's task and whether continuing is still worth paying for. Score the paragraph in " +
          "front of you on its own merit; set worth_paying to false once the marginal paragraph " +
          "stops earning its price.",
        messages: [{
          role: "user",
          content:
            `TASK: ${task}\n` +
            `PARAGRAPHS ALREADY PAID FOR: ${soFar}\n\n` +
            `PARAGRAPH JUST BOUGHT:\n${text}`,
        }],
        output_config: { format: { type: "json_schema", schema: JUDGE_SCHEMA } },
      }),
    });
    if (!r.ok) { log(`   · judge HTTP ${r.status} — falling back to heuristic`); return null; }
    const data = await r.json();
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) return null;
    const out = JSON.parse(block.text);
    const rel = Math.max(0, Math.min(1, Number(out.relevance)));
    return { rel: Number.isFinite(rel) ? rel : 0, worth: out.worth_paying !== false, reason: String(out.reason || "").slice(0, 120) };
  } catch (e) {
    log(`   · judge error (${e.message}) — falling back to heuristic`);
    return null;
  }
}

async function send(label, txPromise) {
  const tx = await txPromise;
  const rc = await tx.wait();
  log(`   ✓ ${label}  ${EXPLORER}/tx/${rc.hash}`);
  return rc;
}

async function main() {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("Set AGENT_PRIVATE_KEY (the reader agent's testnet key).");

  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
  const wallet = new ethers.Wallet(pk, provider);
  const me = wallet.address;
  const usdc = new ethers.Contract(USDC, ERC20, wallet);
  const sp = new ethers.Contract(STREAM_PAY, SP, wallet);

  log(`\n🤖 Reader agent — pays per paragraph on Arc, no human in the loop`);
  log(`   address  ${me}`);
  log(`   task     "${TASK}"`);
  log(`   judge    ${ANTHROPIC_KEY ? `LLM (${JUDGE_MODEL})` : "word-overlap heuristic (set ANTHROPIC_API_KEY for the LLM judge)"}`);
  log(`   balance  $${usd(await usdc.balanceOf(me))}\n`);

  // 1) Free table of contents.
  log(`[1/4] BROWSE — GET /article/${ARTICLE}`);
  const tocRes = await fetchTimeout(`${SERVER_URL}/article/${ARTICLE}`);
  if (tocRes.status !== 200) throw new Error(`TOC failed: ${tocRes.status}`);
  const toc = await tocRes.json();
  // x402 v1 discovery: terms live in accepts[]. We honor the streampay scheme.
  const terms = (toc.x402?.accepts || []).find((a) => a.scheme === "streampay") || toc.x402?.accepts?.[0];
  if (!terms?.payTo) throw new Error("no x402 streampay terms in table of contents");
  const payTo = ethers.getAddress(terms.payTo);
  log(`   "${toc.title}" — ${toc.paragraphs.length} paragraphs, full price $${toc.totalPriceUSDC}`);
  log(`   publisher ${payTo}`);

  // 2) Open the StreamPay micro-stream: the agent's committed budget.
  log(`\n[2/4] FUND — StreamPay micro-stream: $${usd(BUDGET)} over ${STREAM_SECS}s -> publisher`);
  if ((await usdc.allowance(me, STREAM_PAY)) < BUDGET) await send("approve USDC → StreamPay", usdc.approve(STREAM_PAY, ethers.MaxUint256));
  const now = BigInt(Math.floor(Date.now() / 1000));
  await send("createStream", sp.createStream(payTo, BUDGET, now, now + BigInt(STREAM_SECS), `lepton-press:${ARTICLE}`));
  const streamId = (await sp.nextId()) - 1n;
  const rate = BUDGET / BigInt(STREAM_SECS); // micro-USDC/s
  log(`   stream #${streamId} flowing at $${usd(rate)}/s`);

  // Structured record of this run, for the dashboard's interactive replay.
  const runLog = {
    article: ARTICLE, title: toc.title, task: TASK,
    judge: ANTHROPIC_KEY ? { mode: "llm", model: JUDGE_MODEL } : { mode: "heuristic" },
    reader: me, publisher: payTo, streamId: streamId.toString(),
    budgetUSDC: usd(BUDGET), explorer: `${EXPLORER}/tx`, steps: [],
  };

  // 3) Read paragraph by paragraph, deciding after each whether the next is worth paying for.
  log(`\n[3/4] READ — paying per paragraph, stopping when it no longer pays off`);
  let spent = 0n, cold = 0, read = 0, stopReason = "reached the end of the article";
  for (const para of toc.paragraphs) {
    const price = uu(para.priceUSDC);
    if (spent + price > BUDGET) { stopReason = "budget reached"; log(`   · budget reached — stop.`); break; }

    // Prove we own this stream: sign a fresh, stream-scoped access message with the funding
    // key. The publisher recovers the signer and refuses to spend a stream for anyone but its
    // sender — so an id-enumerating freeloader can't drain our budget. TTL covers the retries.
    const ts = Math.floor(Date.now() / 1000);
    const sig = await wallet.signMessage(accessMessage(streamId, para.n, ts));
    // Sign once per paragraph; carry ts+sig in HEADERS (not the URL) so the signature never lands
    // in a log. The same sig rides every retry below — the server consumes it only on the
    // successful settlement, so the poll loop keeps working and replay is closed after payment.
    const headers = { "x-lp-ts": String(ts), "x-lp-sig": sig };

    // Wait until this paragraph's price has vested to the publisher, then buy it.
    let body, status = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await fetchTimeout(`${SERVER_URL}/article/${ARTICLE}/p/${para.n}?stream=${streamId}`, { headers });
        status = r.status; body = await r.json();
        if (status === 200) break;
      } catch (e) {
        status = 0; body = { reason: `request failed (${e.name === "AbortError" ? "timeout" : e.message})` };
      }
      await sleep(700); // let more seconds vest, then retry the gate
    }
    if (status !== 200) { stopReason = `could not settle (${body?.reason || body?.error})`; log(`   ¶${para.n}: could not settle (${body?.reason || body?.error}) — stop.`); break; }

    spent += uu(body.payment.settledUSDC); read++;

    // Decide whether this paragraph (and the next) earns its price. Prefer the LLM judge;
    // fall back to the word-overlap heuristic when no key is configured or the call fails.
    const verdict = await llmJudge(TASK, body.text, read - 1);
    const rel = verdict ? verdict.rel : relevance(TASK, body.text);
    const worth = verdict ? verdict.worth : rel >= 0.12;
    const tag = verdict ? "🧠" : "·";
    log(`   ¶${para.n}: paid $${body.payment.settledUSDC}  ${tag} relevance ${(rel * 100).toFixed(0)}%  ${body.payment.explorer}`);
    if (verdict) log(`        judge: ${verdict.reason}`);
    log(`        "${body.text.slice(0, 90)}…"`);

    runLog.steps.push({
      n: para.n,
      paidUSDC: body.payment.settledUSDC,
      tx: body.payment.settlementTx,
      explorer: body.payment.explorer,
      relevance: Math.round(rel * 100),
      worthPaying: worth,
      judge: verdict ? verdict.reason : null,
      text: body.text,
    });

    // Stopping rule: count a paragraph "cold" when it no longer advances the task (LLM:
    // worth_paying=false; heuristic: relevance below threshold). Give up after GIVE_UP cold
    // paragraphs in a row — the agent paying only for what advances it, decided per tx.
    if (!worth) { cold++; if (cold >= GIVE_UP) { stopReason = "task saturated — stopped paying"; log(`   · ${cold} cold paragraph(s) — task saturated, stop.`); break; } }
    else cold = 0;
  }

  // 4) Reclaim the unspent budget.
  log(`\n[4/4] SETTLE — cancel the stream, reclaim the unspent budget`);
  const st = await sp.get(streamId);
  if (Number(st.status) === 1) {
    log(`   reclaimable $${usd(await sp.senderBalance(streamId))}`);
    await send(`cancel stream #${streamId}`, sp.cancel(streamId));
  } else log(`   stream #${streamId} already terminal — nothing to reclaim.`);

  log(`\n✅ read ${read} paragraph(s), paid $${usd(spent)} total, autonomously, on Arc.`);
  log(`   balance $${usd(await usdc.balanceOf(me))} — every paragraph release was a live StreamPay settlement.\n`);

  if (RUN_LOG) {
    runLog.totals = { paragraphsPaidFor: read, spentUSDC: usd(spent), stopReason };
    writeFileSync(RUN_LOG, JSON.stringify(runLog, null, 2));
    log(`   📝 run recorded → ${RUN_LOG}\n`);
  }
}

main().catch((e) => { console.error("reader error:", e.shortMessage || e.message || e); process.exit(1); });
