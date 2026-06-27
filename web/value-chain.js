const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const short=(a)=>{a=String(a||"—");return esc(a.length>14?a.slice(0,6)+"…"+a.slice(-4):a);};

async function boot(){
  let d;
  try{ const r=await fetch("./broker.json",{cache:"no-store"}); if(!r.ok) throw new Error("broker.json "+r.status); d=await r.json(); }
  catch(e){ $("foot").innerHTML=`<span class="err">Could not load the run:</span> ${esc(e.message)}`; return; }

  const cost=d.hop1.costUSDC, rev=d.hop2.settledUSDC||d.hop2.priceUSDC, profit=d.economics.profitUSDC;
  const exTx=(tx)=>`https://testnet.arcscan.app/tx/${esc(tx)}`;

  $("flow").innerHTML=`
    <div class="node"><div class="role">Publisher</div><div class="who">Lepton Press</div><div class="addr">${short(d.publisher)}</div></div>
    <div class="arrow"><span class="amt">$${esc(cost)}</span><span class="lbl">to read the source</span><span class="ar">→</span></div>
    <div class="node broker"><div class="role">Broker agent</div><div class="who">reads · distills · resells</div><div class="addr">${short(d.broker)}</div></div>
    <div class="arrow"><span class="amt">$${esc(rev)}</span><span class="lbl">for the answer</span><span class="ar">→</span></div>
    <div class="node"><div class="role">Consumer agent</div><div class="who">buys the answer</div><div class="addr">${short(d.consumer)}</div></div>`;

  $("econ").innerHTML=`
    <div class="stat"><div class="l">Broker paid (upstream)</div><div class="v">$${esc(cost)}</div></div>
    <div class="stat"><div class="l">Broker earned (downstream)</div><div class="v gold">$${esc(rev)}</div></div>
    <div class="stat profit"><div class="l">Broker profit</div><div class="v">+$${esc(profit)}</div></div>
    <div class="stat"><div class="l">Markup</div><div class="v">${Math.round(Number(d.hop2.markup)*100)}%</div></div>`;

  const synthLabel=d.synthesis?.mode==="llm"?`synthesized by ${esc(d.synthesis.model||"claude")}`:"extractive synthesis";
  $("qa").innerHTML=`<h2>The product the broker sold <span class="tick"></span></h2>
    <div class="q"><b>Question:</b> ${esc(d.question)}</div>
    <div class="a">${esc(d.answer)}</div>
    <span class="pill">🧠 ${synthLabel}</span>`;

  const judgeHdr=d.judge?.mode==="llm"?`judge (${esc(d.judge.model||"claude")})`:"relevance";
  const rows=(d.hop1.paragraphs||[]).map(p=>`
    <tr>
      <td>#${Number(p.n)}<div class="relbar"><i style="width:${Math.max(2,Math.min(100,Number(p.relevance)||0))}%"></i></div></td>
      <td class="jr">${p.judge?esc(p.judge):""}</td>
      <td class="num">$${esc(p.paidUSDC)}</td>
      <td style="text-align:right"><a href="${exTx(p.tx)}" target="_blank" rel="noopener">${short(p.tx)} ↗</a></td>
    </tr>`).join("");
  $("hop1").innerHTML=`<h2>Hop 1 — broker → publisher (${(d.hop1.paragraphs||[]).length} paid paragraphs · stream #${esc(String(d.hop1.streamId))}) <span class="tick"></span></h2>
    <table><thead><tr><th>¶ / relevance</th><th>${judgeHdr}</th><th style="text-align:right">paid</th><th style="text-align:right">settlement</th></tr></thead><tbody>${rows}</tbody></table>`;

  $("hop2").innerHTML=`<h2>Hop 2 — consumer → broker (stream #${esc(String(d.hop2.streamId))}) <span class="tick"></span></h2>
    <table><tbody>
      <tr><td>Consumer paid the broker for the answer</td><td class="num">$${esc(rev)}</td>
      <td style="text-align:right"><a href="${exTx(d.hop2.tx)}" target="_blank" rel="noopener">${short(d.hop2.tx)} ↗</a></td></tr>
    </tbody></table>`;

  $("foot").innerHTML=`A real two-hop nanopayment value chain on Arc testnet — content → broker → consumer, ${(d.hop1.paragraphs||[]).length+1} on-chain settlements, 0 humans. See the <a href="./replay.html">single-agent replay</a> or the <a href="./index.html">live revenue dashboard</a>.`;
}
boot();
