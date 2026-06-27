#!/usr/bin/env node
// Adversarial paywall-bypass probe. Goal: get paragraph TEXT without a paid on-chain withdraw.
// The canary: paragraph 0 begins "For thirty years". If that string appears in ANY non-200
// (or unpaid) response, the paywall leaked.
import { ethers } from "ethers";
const RPC = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const SP = "0x505739d33D85AD85D0f9eeE64856309782382450";
const USDC = "0x3600000000000000000000000000000000000000";
const BASE = process.env.SERVER_URL || "http://localhost:4031";
const ART = "arc-nanopayments";
const CANARY = "For thirty years";
const am = (id,n,ts)=>`Lepton Press access\nstream: ${id}\nparagraph: ${n}\nts: ${ts}`;
const prov = new ethers.JsonRpcProvider(RPC, 5042002);
const owner = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, prov);
const attacker = ethers.Wallet.createRandom();
const erc = new ethers.Contract(USDC, ["function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)"], owner);
const sp = new ethers.Contract(SP, ["function createStream(address,uint256,uint64,uint64,string) returns(uint256)","function nextId() view returns(uint256)","event Created(uint256 indexed id,address indexed s,address indexed r,uint256 d,uint64 a,uint64 b,string m)"], owner);

const toc = await (await fetch(`${BASE}/article/${ART}`)).json();
const pub = ethers.getAddress((toc.x402.accepts.find(a=>a.scheme==="streampay")||toc.x402.accepts[0]).payTo);

async function openStream(recipient){
  if ((await erc.allowance(owner.address, SP)) < 20000n) await (await erc.approve(SP, ethers.MaxUint256)).wait();
  const now = BigInt(Math.floor(Date.now()/1000));
  const rc = await (await sp.createStream(recipient, 20000n, now, now+60n, "probe")).wait();
  for (const lg of rc.logs){ try{ const p = sp.interface.parseLog(lg); if(p&&p.name==="Created") return p.args.id.toString(); }catch{} }
}
const sidGood = await openStream(pub);          // legit stream to publisher
const sidWrong = await openStream(attacker.address); // stream to a NON-publisher recipient
await new Promise(r=>setTimeout(r,3500)); // let it vest

const ownerSig = async (id,n,ts)=> await owner.signMessage(am(id,n,ts));
const NOW = ()=>Math.floor(Date.now()/1000);

const probes = [];
const add = (name, status, body) => {
  const leak = JSON.stringify(body||"").includes(CANARY);
  probes.push({ name, status, leak, reason: body?.reason||body?.error||(body?.ok?"200-OK":"") });
};
async function hit(name, path, headers={}){ try{ const r=await fetch(`${BASE}${path}`, {headers}); let b; try{b=await r.json();}catch{b={}} add(name, r.status, b);}catch(e){add(name,-1,{error:e.message});} }
const H=(ts,sig)=>({ "x-lp-ts":String(ts), "x-lp-sig":sig }); // ts+sig now ride in headers

// 1 no stream
await hit("no-stream (402, no text)", `/article/${ART}/p/0`);
// 2 stream, no sig header
await hit("stream no-sig (403)", `/article/${ART}/p/0?stream=${sidGood}`);
{ // 3 valid sig for n=0 replayed on n=1
  const ts=NOW(); const s=await ownerSig(sidGood,0,ts);
  await hit("sig n=0 replay on n=1 (403)", `/article/${ART}/p/1?stream=${sidGood}`, H(ts,s));
}
{ // 4 attacker (wrong key) signs
  const ts=NOW(); const s=await attacker.signMessage(am(sidGood,0,ts));
  await hit("wrong-signer (403)", `/article/${ART}/p/0?stream=${sidGood}`, H(ts,s));
}
{ // 5 wrong-recipient stream, valid owner sig
  const ts=NOW(); const s=await ownerSig(sidWrong,0,ts);
  await hit("stream-to-other-recipient (402)", `/article/${ART}/p/0?stream=${sidWrong}`, H(ts,s));
}
{ // 6 stale ts (past)
  const ts=NOW()-300; const s=await ownerSig(sidGood,0,ts);
  await hit("stale ts past (403)", `/article/${ART}/p/0?stream=${sidGood}`, H(ts,s));
}
{ // 7 future ts
  const ts=NOW()+300; const s=await ownerSig(sidGood,0,ts);
  await hit("future ts (403)", `/article/${ART}/p/0?stream=${sidGood}`, H(ts,s));
}
// 8 out-of-range / negative / non-numeric n
await hit("n=999 out-of-range (404)", `/article/${ART}/p/999?stream=${sidGood}`);
await hit("n=-1 (404)", `/article/${ART}/p/-1?stream=${sidGood}`);
await hit("n=abc (404)", `/article/${ART}/p/abc?stream=${sidGood}`);
// 9 bogus streamId
await hit("stream=evil (402)", `/article/${ART}/p/0?stream=not_a_number`);
// 10 legit happy path MUST return text (control) — and consumes the single-use sig
let cTs, cSig;
{
  const ts=NOW(); const s=await ownerSig(sidGood,0,ts); cTs=ts; cSig=s;
  let b; const r=await fetch(`${BASE}/article/${ART}/p/0?stream=${sidGood}`, {headers:H(ts,s)}); try{b=await r.json();}catch{b={}}
  add("LEGIT owner paid (200 + text)", r.status, b);
}
// 11 replay the now-consumed sig -> single-use must reject (no second settlement)
await hit("replay consumed sig (403)", `/article/${ART}/p/0?stream=${sidGood}`, H(cTs, cSig));

console.log("\nPROBE RESULTS (leak=true means TEXT escaped without payment):");
let bad = 0;
for (const p of probes){
  const isControl = p.name.startsWith("LEGIT");
  const ok = isControl ? (p.status===200 && p.leak) : (p.status!==200 && !p.leak);
  if(!ok) bad++;
  console.log(`  ${ok?"✅":"❌"} ${p.name} -> ${p.status} ${p.reason} ${p.leak?"[TEXT-LEAK]":""}`);
}
console.log(bad? `\n❌ ${bad} probe(s) FAILED` : `\n✅ PASS — no unpaid text leak; gate holds on every bypass attempt`);
process.exit(bad?1:0);
