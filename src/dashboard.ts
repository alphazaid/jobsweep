import type { Decision, Job, RunSummary } from "./types.ts"

export interface DashboardData {
  date: string
  cities: string[]
  jobs: Job[]
  newIds: Set<string>
  carriedIds: Set<string>
  decisions: Record<string, Decision>
  runs: RunSummary[]
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
const k = (n: number) => `$${Math.round(n / 1000)}k`

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Postings-per-run line as an inline SVG: flat, one stroke, no axes clutter — the trend is the point. */
function historySvg(runs: RunSummary[]): string {
  if (runs.length < 2) return `<p class="mute">History appears after a couple of runs.</p>`
  const W = 640, H = 140, P = 24
  const max = Math.max(...runs.map((r) => r.total), 1)
  const x = (i: number) => P + (i / (runs.length - 1)) * (W - 2 * P)
  const y = (v: number) => H - P - (v / max) * (H - 2 * P)
  const path = runs.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.total).toFixed(1)}`).join(" ")
  const pathComp = runs.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.withComp).toFixed(1)}`).join(" ")
  const dots = runs.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r.total).toFixed(1)}" r="2.5"><title>${new Date(r.ts).toLocaleString()} · ${r.total} open · ${r.withComp} with comp · ${r.newCount} new</title></circle>`).join("")
  const first = new Date(runs[0]!.ts), last = new Date(runs[runs.length - 1]!.ts)
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Open postings per run">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="axis"/>
    <path d="${pathComp}" class="line comp"/><path d="${path}" class="line"/>${dots}
    <text x="${P}" y="${H - 6}" class="lab">${first.toLocaleDateString()}</text><text x="${W - P}" y="${H - 6}" class="lab" text-anchor="end">${last.toLocaleDateString()}</text>
    <text x="${P}" y="${P - 8}" class="lab">${max} open · thin line = with posted comp</text>
  </svg>`
}

function bars(rows: Array<[string, number]>, total: number): string {
  if (!rows.length) return `<p class="mute">—</p>`
  const max = Math.max(...rows.map(([, n]) => n), 1)
  return `<table class="bars">${rows.map(([label, n]) => `<tr><td class="l">${esc(label)}</td><td class="b"><div style="width:${((n / max) * 100).toFixed(1)}%"></div></td><td class="n">${n}<span class="pct">${total ? Math.round((n / total) * 100) : 0}%</span></td></tr>`).join("")}</table>`
}

export function renderDashboard(d: DashboardData): string {
  const jobs = d.jobs
  const withComp = jobs.filter((j) => j.salary)
  const ceilings = withComp.map((j) => j.salary!.max ?? j.salary!.min!).filter((n): n is number => n != null)
  const reviewed = jobs.filter((j) => j.ai)
  const dec = (s: string) => jobs.filter((j) => d.decisions[j.id]?.status === s).length
  const undecided = jobs.length - dec("apply") - dec("maybe") - dec("skip") - dec("applied")

  const bySource = Object.entries(jobs.reduce<Record<string, number>>((m, j) => ((m[j.source] = (m[j.source] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])
  const bandEdges = [0, 150_000, 200_000, 250_000, 300_000, 400_000, Infinity]
  const byBand: Array<[string, number]> = []
  for (let i = 0; i < bandEdges.length - 1; i++) {
    const lo = bandEdges[i]!, hi = bandEdges[i + 1]!
    const n = ceilings.filter((c) => c >= lo && c < hi).length
    if (n) byBand.push([hi === Infinity ? `${k(lo)}+` : `${k(lo)}–${k(hi)}`, n])
  }
  const byLevel = Object.entries(jobs.reduce<Record<string, number>>((m, j) => ((m[j.level] = (m[j.level] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])
  const topCompanies = Object.entries(jobs.reduce<Record<string, number>>((m, j) => ((m[j.company ?? "—"] = (m[j.company ?? "—"] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 8)
  const fitDist = reviewed.length ? [5, 4, 3, 2, 1].map((f) => [`${f} — ${{ 5: "apply today", 4: "apply", 3: "maybe", 2: "unlikely", 1: "skip" }[f]}`, reviewed.filter((j) => j.ai!.fit === f).length] as [string, number]).filter(([, n]) => n) : []
  const lastRun = d.runs[d.runs.length - 1]

  const card = (n: string | number, label: string, sub = "") => `<div class="card"><div class="n">${n}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>jobsweep · ${esc(d.cities.join(" / "))}</title>
<style>
:root{--bg:#F5F6F8;--panel:#fff;--ink:#16181D;--mute:#6B7280;--rule:#DDE0E5;--accent:#1D4ED8;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 var(--sans);color:var(--ink);background:var(--bg)}
header{display:flex;align-items:center;gap:16px;padding:12px 24px;background:var(--panel);border-bottom:1px solid var(--rule)}
header h1{font-size:15px;font-weight:600;margin:0;letter-spacing:-.01em}header .meta{color:var(--mute);font-size:12px}
nav{margin-left:auto;display:flex;gap:14px;font-size:13px}nav a{color:var(--ink);text-decoration:none;border-bottom:1px solid transparent}nav a:hover{border-color:var(--ink)}nav a.cur{border-color:var(--ink)}
main{max-width:1100px;margin:0 auto;padding:20px 24px 60px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:22px}
.card{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:12px 14px}.card .n{font-family:var(--mono);font-size:24px;font-weight:600;letter-spacing:-.02em}.card .l{color:var(--mute);font-size:12px;margin-top:2px}.card .s{font-family:var(--mono);font-size:11px;color:var(--mute);margin-top:4px}
h2{font-size:13px;font-weight:600;color:var(--mute);text-transform:uppercase;letter-spacing:.04em;margin:22px 0 8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}@media(max-width:800px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:14px 16px}
.chart{width:100%;height:auto;display:block}.chart .line{fill:none;stroke:var(--ink);stroke-width:1.8}.chart .line.comp{stroke:var(--mute);stroke-width:1;stroke-dasharray:3 3}.chart .axis{stroke:var(--rule)}.chart circle{fill:var(--ink)}.chart .lab{font-family:var(--mono);font-size:10px;fill:var(--mute)}
.bars{width:100%;border-collapse:collapse;font-size:13px}.bars td{padding:3px 0;vertical-align:middle}.bars .l{width:40%;padding-right:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}.bars .b div{height:10px;background:var(--ink);border-radius:2px;min-width:2px}.bars .n{width:80px;text-align:right;font-family:var(--mono);font-size:12px}.bars .pct{color:var(--mute);margin-left:6px}
.mute{color:var(--mute)}
.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button,.btn{font:inherit;font-size:13px;padding:7px 12px;border-radius:5px;border:1px solid var(--rule);background:var(--panel);color:var(--ink);cursor:pointer;text-decoration:none}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}button[disabled]{opacity:.5;cursor:default}
pre#log{background:#0F1115;color:#D7DAE0;font-family:var(--mono);font-size:12px;padding:12px;border-radius:6px;max-height:280px;overflow:auto;white-space:pre-wrap;margin-top:10px;display:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
</style></head><body>
<header><h1>jobsweep</h1><span class="meta">${esc(d.cities.join(" / "))} · last search ${esc(d.date)}${lastRun ? ` · ${new Date(lastRun.ts).toLocaleTimeString()}` : ""}</span>
<nav><a class="cur" href="/">Dashboard</a><a href="/triage">Triage</a><a href="/api/jobs.csv">Export CSV</a><a href="/api/jobs.json">Export JSON</a><a href="/api/decisions.json">Decisions</a></nav></header>
<main>
<div class="cards">
${card(jobs.length, "open matches", `${d.carriedIds.size} carried · ${d.newIds.size} new`)}
${card(withComp.length, "with posted comp", `${jobs.length ? Math.round((withComp.length / jobs.length) * 100) : 0}% of open`)}
${card(median(ceilings) === null ? "—" : k(median(ceilings)!), "median comp ceiling", ceilings.length ? `top ${k(Math.max(...ceilings))}` : "")}
${card(dec("apply") + dec("applied"), "marked apply", `${dec("applied")} applied · ${dec("maybe")} maybe`)}
${card(undecided, "to review", `${dec("skip")} skipped`)}
${card(reviewed.length, "AI reviewed", reviewed.length ? `${reviewed.filter((j) => j.ai!.fit >= 4).length} scored 4+` : "run jobsweep rank")}
</div>
<div class="panel"><div class="actions"><button class="primary" id="run">Run search now</button><span class="mute" id="runstate">Sweeps every source with your profile; takes about a minute warm.</span></div><pre id="log"></pre></div>
<h2>Open postings per run</h2><div class="panel">${historySvg(d.runs)}</div>
<div class="grid">
<div><h2>By source</h2><div class="panel">${bars(bySource, jobs.length)}</div></div>
<div><h2>Comp ceiling</h2><div class="panel">${bars(byBand, ceilings.length)}</div></div>
<div><h2>Title band</h2><div class="panel">${bars(byLevel, jobs.length)}</div></div>
<div><h2>Most postings</h2><div class="panel">${bars(topCompanies, jobs.length)}</div></div>
<div><h2>Decisions</h2><div class="panel">${bars([["to review", undecided], ["apply", dec("apply")], ["maybe", dec("maybe")], ["applied", dec("applied")], ["skipped", dec("skip")]], jobs.length)}</div></div>
<div><h2>AI fit</h2><div class="panel">${fitDist.length ? bars(fitDist, reviewed.length) : `<p class="mute">No reviews yet — <code>jobsweep rank</code> with a model configured.</p>`}</div></div>
</div>
</main>
<script>
const btn=document.getElementById("run"),log=document.getElementById("log"),state=document.getElementById("runstate");
btn.onclick=async()=>{btn.disabled=true;log.style.display="block";log.textContent="";state.textContent="running…";
  const r=await fetch("/api/run",{method:"POST"});if(!r.ok){state.textContent="could not start: "+await r.text();btn.disabled=false;return;}
  const es=new EventSource("/api/run/stream");
  es.onmessage=e=>{log.textContent+=e.data+"\\n";log.scrollTop=log.scrollHeight;};
  es.addEventListener("done",e=>{es.close();state.textContent="done — reloading";setTimeout(()=>location.reload(),600);});
  es.onerror=()=>{es.close();state.textContent="stream ended";btn.disabled=false;};};
</script></body></html>`
}
