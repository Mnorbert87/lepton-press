const $ = (id) => document.getElementById(id);
const short = (a) => a.length > 14 ? a.slice(0,6)+"…"+a.slice(-4) : a;
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

let data = null, idx = 0, stopped = false;

async function boot() {
  try {
    const res = await fetch("./run.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`run.json ${res.status}`);
    data = await res.json();
  } catch (e) {
    $("foot").innerHTML = `<span class="err">Could not load the run:</span> ${esc(e.message)}`;
    return;
  }
  renderMeta();
  $("taskbar").hidden = false;
  $("task").textContent = data.task;
  $("controls").hidden = false;
  $("next").onclick = revealNext;
  $("reset").onclick = reset;
  updateButton();
  // Optional deep-link: ?auto=N pre-reveals N steps (handy for sharing a specific moment).
  const auto = Number(new URLSearchParams(location.search).get("auto"));
  if (Number.isFinite(auto) && auto > 0) for (let i = 0; i < auto && !stopped && idx < (data.steps||[]).length; i++) revealNext();
}

function renderMeta() {
  const j = data.judge || {};
  const judgeLabel = j.mode === "llm" ? `🧠 LLM judge · ${esc(j.model || "claude")}` : "word-overlap judge";
  const m = [];
  if (data.sample) m.push(`<span class="chip sample">sample run — live capture pending</span>`);
  m.push(`<span class="chip judge">${judgeLabel}</span>`);
  m.push(`<span class="chip">article <b>${esc(data.title || data.article)}</b></span>`);
  m.push(`<span class="chip">reader <b>${esc(short(data.reader || "—"))}</b></span>`);
  m.push(`<span class="chip">budget <b>$${esc(data.budgetUSDC || "—")}</b></span>`);
  $("meta").innerHTML = m.join("");
}

function revealNext() {
  const steps = data.steps || [];
  if (idx >= steps.length || stopped) return;
  const s = steps[idx]; idx++;
  const isStop = s.worthPaying === false;
  const el = document.createElement("div");
  el.className = "step" + (isStop ? " stop" : "");
  el.innerHTML = `
    <div class="head">
      <span class="pn">paragraph ${Number(s.n)}</span>
      <span class="paid">paid $${esc(s.paidUSDC)}</span>
      ${s.explorer ? `<a class="txlink" href="${esc(s.explorer)}" target="_blank" rel="noopener">settled · ${short(esc(s.tx || ""))} ↗</a>` : ""}
    </div>
    <div class="ptext">${esc(s.text)}</div>
    <div class="verdict">
      <div class="relrow">
        <div class="relbar"><i style="width:0%"></i></div>
        <span class="relnum">relevance ${Number(s.relevance)}%</span>
      </div>
      ${s.judge ? `<div class="judge"><span class="ic">🧠</span><span><b style="color:var(--ink)">Judge:</b> ${esc(s.judge)}</span></div>` : ""}
      <div><span class="decision ${isStop ? "stop" : "keep"}">${isStop ? "stops paying — task saturated" : "worth it — keep reading"}</span></div>
    </div>`;
  $("stream").appendChild(el);
  requestAnimationFrame(() => { el.querySelector(".relbar i").style.width = Math.max(2, Math.min(100, Number(s.relevance) || 0)) + "%"; });
  if (isStop) stopped = true;
  updateButton();
  if (stopped || idx >= steps.length) finish();
}

function updateButton() {
  const steps = data.steps || [];
  const btn = $("next");
  if (stopped || idx >= steps.length) { btn.hidden = true; $("reset").hidden = false; return; }
  btn.disabled = false;
  btn.textContent = idx === 0 ? "Buy the first paragraph →" : "Buy the next paragraph →";
  $("hint").textContent = `${idx} of ${steps.length} bought · the agent decides after each whether the next is worth it`;
}

function finish() {
  const t = data.totals || {};
  const stoppedByJudge = stopped;
  $("summary").innerHTML = `
    <div class="summary">
      <h3>${stoppedByJudge ? "The agent stopped paying." : "The agent finished the article."}</h3>
      <p>${stoppedByJudge
        ? "It bought exactly the paragraphs that advanced its task, then declined the rest — per-read economics, decided transaction by transaction. That restraint is the whole thesis: a reader that simply drained its budget would never stop early."
        : "It paid through to the end because every paragraph kept earning its price."}
        Each settlement above is a real <code>withdraw()</code> on Arc — the hashes are permanent.</p>
      <div class="nums">
        <div><div class="v">${esc(t.paragraphsPaidFor ?? idx)}</div><div class="l">paragraphs paid</div></div>
        <div><div class="v">$${esc(t.spentUSDC ?? "—")}</div><div class="l">USDC settled</div></div>
        <div><div class="v">0</div><div class="l">humans in the loop</div></div>
      </div>
    </div>`;
  $("hint").textContent = "";
}

function reset() {
  idx = 0; stopped = false;
  $("stream").innerHTML = ""; $("summary").innerHTML = "";
  $("next").hidden = false; $("reset").hidden = true;
  updateButton();
}

$("foot").innerHTML = `Replay of a captured on-chain run — the settlement hashes are real and verifiable. See the <a href="./value-chain.html" style="color:var(--gold2)">two-hop agent economy</a> or the live <a href="./index.html" style="color:var(--gold2)">revenue dashboard</a>.`;
boot();
