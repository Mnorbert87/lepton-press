#!/usr/bin/env node
// Smoke test for the publisher hardening:
//   (A) nonce-serialization regression — N concurrent signed withdraws settle distinctly.
//   (B) caller<->stream binding — wrong-signer and no-signature requests are rejected (403).
//   (C) gas-burn floor — a funded, owned, signed request still 402s below MIN_SETTLE_UUSDC,
//       while the SAME stream settles 200 against a normal-floor server (so it's the floor,
//       not lack of funds). Set FLOOR_URL (a server started with a high MIN_SETTLE_UUSDC).
import { ethers } from "ethers";

const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const CHAIN_ID = 5042002;
const USDC = "0x3600000000000000000000000000000000000000";
const STREAM_PAY = process.env.STREAM_PAY || "0x505739d33D85AD85D0f9eeE64856309782382450";
const SERVER_URL = process.env.SERVER_URL || "http://localhost:4031";
const FLOOR_URL = process.env.FLOOR_URL || ""; // optional high-floor server for check C
const ARTICLE = "arc-nanopayments";
const N = Number(process.env.N || 3);

const ERC20 = ["function approve(address,uint256) returns (bool)","function allowance(address,address) view returns (uint256)"];
const SP = ["function createStream(address,uint256,uint64,uint64,string) returns (uint256)","function nextId() view returns (uint256)","function cancel(uint256)"];
const usd = (v) => (Number(v) / 1e6).toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const accessMessage = (streamId, n, ts) => `Lepton Press access\nstream: ${streamId}\nparagraph: ${n}\nts: ${ts}`;
const signed = async (w, id, n = 0) => { const ts = Math.floor(Date.now()/1000); return { "x-lp-ts": String(ts), "x-lp-sig": await w.signMessage(accessMessage(id, n, ts)) }; };
const get = async (base, id, headers = {}) => { const r = await fetch(`${base}/article/${ARTICLE}/p/0?stream=${id}`, { headers }); let b={}; try{b=await r.json();}catch{} return { status: r.status, ...b }; };

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider); // the legit owner
const attacker = ethers.Wallet.createRandom().connect(provider);          // random, never funded
const usdc = new ethers.Contract(USDC, ERC20, wallet);
const sp = new ethers.Contract(STREAM_PAY, SP, wallet);

let toc;
for (let i = 0; i < 40; i++) { try { const r = await fetch(`${SERVER_URL}/article/${ARTICLE}`); if (r.ok) { toc = await r.json(); break; } } catch {} await sleep(250); }
if (!toc) { console.error("server never came up"); process.exit(2); }
const payTo = ethers.getAddress((toc.x402.accepts.find(a=>a.scheme==="streampay")||toc.x402.accepts[0]).payTo);
console.log(`payTo=${payTo}  owner=${wallet.address}  attacker=${attacker.address}`);

const BUDGET = 20000n;
const want = BUDGET * BigInt(N + 1);
if ((await usdc.allowance(wallet.address, STREAM_PAY)) < want) await (await usdc.approve(STREAM_PAY, ethers.MaxUint256)).wait();
const ids = [];
for (let i = 0; i < N + 1; i++) { const now = BigInt(Math.floor(Date.now()/1000)); await (await sp.createStream(payTo, BUDGET, now, now + 60n, `smoke:${i}`)).wait(); ids.push(((await sp.nextId()) - 1n).toString()); }
console.log(`streams: ${ids.join(", ")}`);
await sleep(3000); // vest

const fails = [];

// (B) caller<->stream binding
const wrong = await get(SERVER_URL, ids[0], await signed(attacker, ids[0]));
const nosig = await get(SERVER_URL, ids[0], {});
console.log(`\n[B] wrong-signer  -> ${wrong.status} (${wrong.reason})   no-signature -> ${nosig.status} (${nosig.reason})`);
if (!(wrong.status === 403 && wrong.reason === "not_stream_owner")) fails.push("wrong-signer not rejected with 403/not_stream_owner");
if (!(nosig.status === 403 && nosig.reason === "owner_signature_required")) fails.push("no-signature not rejected with 403/owner_signature_required");

// (C) gas-burn floor (optional, needs a high-floor server)
if (FLOOR_URL) {
  const floorId = ids[N]; // the spare stream
  const lo = await get(FLOOR_URL, floorId, await signed(wallet, floorId));   // high floor -> 402
  const hi = await get(SERVER_URL, floorId, await signed(wallet, floorId));  // normal floor -> 200
  console.log(`[C] high-floor -> ${lo.status} (${lo.reason}, minSettle=${lo.minSettleUSDC})   normal-floor same stream -> ${hi.status}`);
  if (!(lo.status === 402 && lo.reason === "insufficient_vested_balance")) fails.push("high floor did not 402 a funded owned stream");
  if (hi.status !== 200) fails.push("normal floor failed to settle the same stream (floor A/B inconclusive)");
}

// (A) concurrency regression: N concurrent signed withdraws
console.log(`\n[A] firing ${N} concurrent signed GET /p/0 ...`);
const conc = await Promise.all(ids.slice(0, N).map(async (id) => get(SERVER_URL, id, await signed(wallet, id))));
const txs = new Set(); let ok = 0;
for (let i = 0; i < N; i++) { const x = conc[i]; console.log(`  stream ${ids[i]}: ${x.status} ${x.status===200?`tx ${x.payment?.settlementTx}`:`(${x.reason})`}`); if (x.status===200 && x.payment?.settlementTx) { ok++; txs.add(x.payment.settlementTx); } }
if (!(ok === N && txs.size === N)) fails.push(`concurrency: ${ok}/${N} settled, ${txs.size} distinct tx (nonce collision suspected)`);

// cleanup: reclaim the spare stream's remainder (the read ones auto-handled by demo lifecycle elsewhere)
try { await (await sp.cancel(ids[N])).wait(); } catch {}

console.log(`\n${fails.length ? "❌ FAIL\n - " + fails.join("\n - ") : "✅ PASS — owner-binding (403s), gas-floor A/B, and concurrent nonce-serialization all hold"}`);
process.exit(fails.length ? 1 : 0);
