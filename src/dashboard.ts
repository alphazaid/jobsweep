import { themeCss, themeScript, themeSwitcher, type ThemePrefs } from "./theme.ts"
import { ALL_SOURCES, PRESETS, type Decision, type Job, type RunSummary } from "./types.ts"

export interface DashboardData {
  date: string
  cities: string[]
  jobs: Job[]
  newIds: Set<string>
  carriedIds: Set<string>
  decisions: Record<string, Decision>
  runs: RunSummary[]
  theme?: ThemePrefs
  /** The standing profile, to prefill the search form. */
  profile?: { preset: string; cities: string[]; minTc: number | null; maxYoe: number | null; days: number | null; remote: string; sources: string[]; linkedinAccepted: boolean } | null
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
  return `<div class="chart-label">${max} open · thin line = with posted comp</div>
  <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Open postings per run">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" class="axis"/>
    <path d="${pathComp}" class="line comp"/><path d="${path}" class="line"/>${dots}
  </svg>
  <div class="chart-label chart-dates"><span>${first.toLocaleDateString()}</span><span>${last.toLocaleDateString()}</span></div>`
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

  const card = (n: string | number, label: string, sub = "") => `<div class="card"><div class="l">${label}</div><div class="n">${n}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>jobsweep · ${esc(d.cities.join(" / "))}</title>
${themeScript(d.theme ?? {})}
<style>
${themeCss()}
:root{--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:24px}body{margin:0;font:14px/1.5 var(--sans);color:var(--ink);background:var(--bg)}
a{color:inherit}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}
.sidebar{position:fixed;inset:0 auto 0 0;width:212px;padding:32px 20px 24px;border-right:1px solid var(--rule);background:var(--panel);display:flex;flex-direction:column;gap:40px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-size:21px;font-weight:700;letter-spacing:-1px}.brand-mark{display:grid;place-items:center;width:28px;height:28px;background:var(--ink);color:var(--panel);border-radius:7px;font:600 15px var(--mono);letter-spacing:-3px;padding-right:3px}
.nav-label,.eyebrow{font-size:10px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
.nav-label{padding:0 12px;margin-bottom:12px}.sidebar nav{display:grid;gap:5px}.sidebar nav a{padding:10px 12px;border-radius:6px;color:var(--mute);text-decoration:none;font-size:13px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.sidebar nav a:hover{background:var(--bg);color:var(--ink)}.sidebar nav .cur{background:var(--sel);color:var(--accent);font-weight:600}.nav-count{font:11px var(--mono)}
.sidebar-foot{margin-top:auto;padding:16px 12px 0;border-top:1px solid var(--rule);color:var(--mute);font-size:11px}.sidebar-foot strong{display:block;color:var(--ink);font-weight:500;margin-bottom:4px}
.workspace{margin-left:212px}.topbar{min-height:77px;padding:18px 36px;border-bottom:1px solid var(--rule);display:flex;align-items:center;justify-content:space-between;gap:18px;background:var(--panel)}.breadcrumb{font-size:12px;color:var(--mute)}.breadcrumb span{color:var(--ink);margin-left:10px}
.theme{margin-left:0;gap:4px}.theme select,.theme button{padding:6px 8px;border-radius:5px}.theme button{text-transform:capitalize}
main{max-width:1440px;margin:0 auto;padding:36px 36px 48px}.page-heading{display:flex;justify-content:space-between;gap:24px;align-items:center;margin-bottom:28px}.page-heading h1{font-size:30px;line-height:1.2;letter-spacing:-1px;font-weight:650;margin:8px 0 10px}.page-heading p{margin:0;color:var(--mute);font-size:12px}.heading-actions{display:flex;gap:8px;flex-shrink:0}
button,.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;font:500 12px/1.5 var(--sans);padding:10px 15px;border-radius:6px;border:1px solid var(--rule);background:var(--panel);color:var(--ink);cursor:pointer;text-decoration:none;white-space:nowrap}
button:hover,.btn:hover{border-color:var(--mute)}.primary{background:var(--ink);color:var(--panel);border-color:var(--ink)}.primary:hover{opacity:.85}button[disabled]{opacity:.5;cursor:default}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:24px}.card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:20px}.card .l{font-size:12px;color:var(--mute)}.card .n{font-size:32px;line-height:1.25;font-weight:600;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin:10px 0}.card .s{font-size:11px;color:var(--mute)}
.panel{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:22px;min-width:0}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.panel h2{font-size:14px;letter-spacing:-.2px;font-weight:600;margin:0}.panel-head p,.section-heading p{font-size:12px;color:var(--mute);margin:4px 0 0}.tag{font:10px var(--mono);border:1px solid var(--rule);padding:4px 7px;border-radius:4px;color:var(--mute);white-space:nowrap}
.overview-grid{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(250px,1fr);gap:20px;margin-bottom:24px}.history-panel{display:flex;flex-direction:column}.history-panel .chart{margin:auto 0}.chart{width:100%;height:auto;display:block}.chart .line{fill:none;stroke:var(--accent);stroke-width:2}.chart .line.comp{stroke:var(--mute);stroke-width:1;stroke-dasharray:3 3}.chart .axis{stroke:var(--rule)}.chart circle{fill:var(--accent)}.chart-label{font:12px/1.5 var(--mono);color:var(--mute);padding:0 3.75%}.chart-dates{display:flex;justify-content:space-between;gap:12px}
.queue{background:var(--sel);display:flex;flex-direction:column}.queue .queue-number{font-size:44px;line-height:1.1;font-weight:600;letter-spacing:-2px;margin:20px 0 8px;font-variant-numeric:tabular-nums}.queue p{margin:0 0 22px;font-size:12px;color:var(--mute);max-width:280px}.queue .btn{align-self:flex-start;margin-top:auto}.queue-foot{font-size:11px;color:var(--mute);margin-top:16px;padding-top:14px;border-top:1px solid var(--rule)}
.search-panel{margin-bottom:34px;padding:0;overflow:hidden}.search-panel summary{cursor:pointer;list-style:none;padding:20px 22px;display:flex;align-items:center;gap:16px}.search-panel summary::-webkit-details-marker{display:none}.search-panel summary strong{display:block;font-size:13px;font-weight:600}.search-panel summary .summary-copy{flex:1;min-width:0}.search-panel summary small{display:block;font-size:12px;color:var(--mute);margin-top:4px;overflow-wrap:anywhere}.summary-toggle{font-size:12px;color:var(--accent);white-space:nowrap}.summary-toggle:after{content:" +";font-family:var(--mono)}details[open] .summary-toggle:after{content:" −"}details[open] summary{border-bottom:1px solid var(--rule)}
.search-body{padding:22px}.runform{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px 16px;align-items:end}.runform label{display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--mute);min-width:0}.runform label:has([name=preset]),.runform label:has([name=cities]){grid-column:span 2}
.runform input,.runform select{font:inherit;font-size:13px;color:var(--ink);background:var(--panel);border:1px solid var(--rule);border-radius:5px;padding:10px;min-width:0;max-width:100%;width:100%}.runform .hint{font-size:10px}.runform fieldset{grid-column:1/-1;border:1px solid var(--rule);border-radius:5px;padding:12px;margin:0;display:flex;gap:14px;flex-wrap:wrap}.runform legend{font-size:11px;color:var(--mute);padding:0 4px}
.runform label.chk{flex-direction:row;align-items:center;gap:7px;color:var(--ink);font-size:12px;grid-column:span 2}.runform label.chk input{accent-color:var(--accent);width:15px;height:15px;margin:0}.runform .actions{grid-column:1/-1;display:flex;gap:14px;align-items:center;margin-top:4px}.runform .actions .mute{font-size:11px;max-width:480px}
pre#log{background:var(--code);color:var(--codeInk);font-family:var(--mono);font-size:12px;padding:16px;border-radius:6px;max-height:280px;overflow:auto;white-space:pre-wrap;margin:18px 0 0;display:none}
.section-heading{display:flex;align-items:end;justify-content:space-between;margin:0 0 18px}.section-heading h2{font-size:18px;letter-spacing:-.4px;margin:0;font-weight:600}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.bars{width:100%;border-collapse:collapse;font-size:12px}.bars td{padding:8px 0;vertical-align:middle}.bars .l{width:39%;padding-right:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:0}.bars .b{width:38%}.bars .b div{height:6px;background:var(--accent);border-radius:2px}.bars .n{width:84px;text-align:right;font-family:var(--mono);font-size:11px;padding-left:10px;white-space:nowrap}.bars .pct{display:inline-block;color:var(--mute);margin-left:8px;min-width:28px}
.mute{color:var(--mute)}.empty-state{border:1px dashed var(--rule);border-radius:6px;padding:22px;font-size:12px;color:var(--mute)}.empty-state strong{display:block;color:var(--ink);font-size:13px;font-weight:500;margin-bottom:6px}.empty-state p{margin:0;line-height:1.8}code{font:11px var(--mono)}.page-footer{display:flex;justify-content:space-between;gap:16px;margin-top:28px;color:var(--mute);font-size:11px}.page-footer a{text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@media(min-width:1500px){main{padding-top:44px}.card{padding:24px}.panel{padding:26px}.search-panel{padding:0}}
@media(max-width:1100px){.sidebar{width:180px;padding:28px 14px}.workspace{margin-left:180px}.topbar{padding:18px 24px}main{padding:28px 24px}.cards{gap:10px}.card{padding:16px}.card .n{font-size:28px}.page-heading{align-items:flex-start}.page-heading h1{font-size:26px}.heading-actions{flex-direction:column}.overview-grid{grid-template-columns:minmax(0,1.4fr) minmax(220px,1fr)}}
@media(max-width:800px){.sidebar{position:static;width:auto;padding:16px 20px;flex-direction:row;align-items:center;gap:24px;border-right:0;border-bottom:1px solid var(--rule)}.brand{font-size:19px}.sidebar nav{display:flex;gap:4px}.sidebar nav a{padding:8px 10px}.sidebar .nav-label,.sidebar .resources,.sidebar-foot{display:none}.workspace{margin-left:0}.topbar{padding:12px 20px;min-height:58px}.breadcrumb{display:none}.theme{flex-wrap:wrap}.overview-grid{grid-template-columns:minmax(0,1.5fr) minmax(220px,1fr)}main{padding:26px 20px}.card .n{font-size:26px}.panel{padding:18px}.search-panel{padding:0}}
@media(max-width:600px){.sidebar{justify-content:space-between;gap:12px}.sidebar nav a{font-size:12px}.sidebar nav a[href="#insights"]{display:none}.nav-count{display:none}.page-heading{flex-direction:column;gap:18px;margin-bottom:22px}.page-heading h1{font-size:27px}.heading-actions{flex-direction:row;width:100%}.heading-actions .btn{flex:1}.cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card .n{font-size:30px}.overview-grid,.grid{grid-template-columns:minmax(0,1fr);gap:16px}.overview-grid{margin-bottom:16px}.queue .queue-number{margin-top:10px}.queue p{max-width:none}.search-panel summary{padding:18px;align-items:flex-start;gap:10px}.summary-toggle{font-size:11px}.search-body{padding:18px}.runform{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 12px}.runform .actions{align-items:flex-start;flex-direction:column}.runform label.chk{grid-column:1/-1}.runform fieldset label.chk{grid-column:auto}.page-footer{flex-direction:column;gap:8px}.panel-head{gap:10px}.tag{font-size:9px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style></head><body>
<aside class="sidebar" aria-label="Workspace navigation">
<a class="brand" href="/"><span class="brand-mark" aria-hidden="true">//</span>jobsweep</a>
<div><div class="nav-label">Workspace</div><nav aria-label="Main"><a class="cur" href="/" aria-current="page">Overview</a><a href="/triage">Triage <span class="nav-count">${undecided}</span></a><a href="#insights">Insights</a></nav></div>
<div class="resources"><div class="nav-label">Your data</div><nav aria-label="Exports"><a href="/api/jobs.csv">Export CSV <span aria-hidden="true">↗</span></a><a href="/api/jobs.json">Export JSON <span aria-hidden="true">↗</span></a><a href="/api/decisions.json">Decisions <span aria-hidden="true">↗</span></a></nav></div>
<div class="sidebar-foot"><strong>Local by design.</strong>Your search stays on your machine.</div>
</aside>
<div class="workspace"><header class="topbar"><div class="breadcrumb">Workspace <span>/ &nbsp; Overview</span></div>${themeSwitcher()}</header>
<main id="overview">
<div class="page-heading"><div><div class="eyebrow">Your job search</div><h1>Your search, at a glance.</h1><p>${esc(d.cities.join(" / ") || "All locations")} · Last search ${esc(d.date)}${lastRun ? ` at ${new Date(lastRun.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</p></div><div class="heading-actions"><a class="btn" href="#search">Search settings</a><a class="btn primary" href="/triage">Review jobs <span aria-hidden="true">→</span></a></div></div>
<section class="cards" aria-label="Search summary">
${card(jobs.length, "Open matches", `${d.carriedIds.size} carried · ${d.newIds.size} new`)}
${card(withComp.length, "With posted comp", `${jobs.length ? Math.round((withComp.length / jobs.length) * 100) : 0}% of open matches`)}
${card(median(ceilings) === null ? "—" : k(median(ceilings)!), "Median comp ceiling", ceilings.length ? `Highest ceiling ${k(Math.max(...ceilings))}` : "No compensation posted")}
${card(dec("apply") + dec("applied"), "Marked to apply", `${dec("applied")} applied · ${dec("maybe")} maybe`)}
</section>
<div class="overview-grid"><section class="panel history-panel"><div class="panel-head"><div><h2>Search activity</h2><p>Open postings across your search runs</p></div><span class="tag">${d.runs.length} runs</span></div>${historySvg(d.runs)}</section>
<section class="panel queue"><div class="eyebrow">Your next step</div><div class="queue-number">${undecided}</div><h2>${undecided === 1 ? "job waiting for a decision" : "jobs waiting for a decision"}</h2><p>${undecided ? "Review the details, shortlist your favorites, and keep your search moving." : jobs.length ? "You’re all caught up. Revisit your shortlist or run a fresh search." : "Run your first search to start building your shortlist."}</p><a class="btn primary" href="/triage">${undecided ? "Start reviewing" : "Open triage"} <span aria-hidden="true">→</span></a><div class="queue-foot">${dec("skip")} skipped · ${reviewed.length} AI reviewed${reviewed.length ? ` · ${reviewed.filter((j) => j.ai!.fit >= 4).length} scored 4+` : ""}</div></section></div>
<details class="panel search-panel" id="search"${jobs.length ? "" : " open"}><summary><div class="summary-copy"><strong>Search configuration</strong><small>${esc(d.profile?.cities.join(" / ") || "Choose your cities")}${d.profile?.minTc != null ? ` · ${k(d.profile.minTc)} minimum comp` : ""}${d.profile?.maxYoe != null ? ` · Up to ${d.profile.maxYoe} years` : ""} · Adjust for your next run</small></div><span class="summary-toggle">Configure search</span></summary><div class="search-body">
<form id="runform" class="runform" autocomplete="off">
  <label>Role<select name="preset">${Object.entries(PRESETS).map(([id, p]) => `<option value="${id}"${id === (d.profile?.preset ?? "swe") ? " selected" : ""}>${esc(id)} — ${esc(p.description)}</option>`).join("")}</select></label>
  <label>Cities <span class="hint">separate with ;</span><input name="cities" value="${esc(d.profile?.cities.join("; ") ?? "")}" placeholder="New York, NY; Austin, TX" required></label>
  <label>Comp floor<input name="minTc" value="${d.profile?.minTc != null ? `${Math.round(d.profile.minTc / 1000)}k` : ""}" placeholder="any" size="7"></label>
  <label>Max years<input name="maxYoe" type="number" min="0" max="60" value="${d.profile?.maxYoe ?? ""}" placeholder="any" size="4"></label>
  <label>Days<input name="days" type="number" min="1" max="3650" value="${d.profile?.days ?? ""}" placeholder="any" size="4"></label>
  <label>Remote<select name="remote">${["include", "only", "exclude"].map((r) => `<option value="${r}"${r === (d.profile?.remote ?? "include") ? " selected" : ""}>${r}</option>`).join("")}</select></label>
  <fieldset><legend>Sources</legend>${ALL_SOURCES.map((src) => `<label class="chk"><input type="checkbox" name="sources" value="${src}"${(d.profile?.sources ?? []).includes(src) ? " checked" : ""}${src === "linkedin" && !d.profile?.linkedinAccepted ? " disabled title=\"Enable in jobsweep init first\"" : ""}>${src}</label>`).join("")}</fieldset>
  <label class="chk"><input type="checkbox" name="new">Only postings not seen before</label>
  <label class="chk"><input type="checkbox" name="save">Save these as my defaults</label>
  <div class="actions"><button class="primary" id="run" type="submit">Run search</button><span class="mute" id="runstate">Prefilled from your profile; change anything for this run, or tick “save” to keep it.</span></div>
</form>
<pre id="log" aria-label="Search progress" role="log"></pre></div></details>
<div class="section-heading" id="insights"><div><h2>Behind the matches</h2><p>Where your opportunities are coming from.</p></div></div>
<div class="grid">
<section class="panel"><div class="panel-head"><div><h2>Sources</h2><p>Open matches by job board</p></div><span class="tag">${bySource.length} sources</span></div>${bars(bySource, jobs.length)}</section>
<section class="panel"><div class="panel-head"><div><h2>Compensation</h2><p>Posted compensation ceilings, not guaranteed offers</p></div></div>${bars(byBand, ceilings.length)}</section>
<section class="panel"><div class="panel-head"><div><h2>Companies hiring</h2><p>Most open matches in your search</p></div><span class="tag">Top ${topCompanies.length}</span></div>${bars(topCompanies, jobs.length)}</section>
<section class="panel"><div class="panel-head"><div><h2>Experience levels</h2><p>Seniority inferred from posting titles</p></div></div>${bars(byLevel, jobs.length)}</section>
<section class="panel"><div class="panel-head"><div><h2>Your pipeline</h2><p>Decisions across your open matches</p></div><a href="/triage" class="mute">Triage →</a></div>${bars([["To review", undecided], ["Apply", dec("apply")], ["Maybe", dec("maybe")], ["Applied", dec("applied")], ["Skipped", dec("skip")]], jobs.length)}</section>
<section class="panel"><div class="panel-head"><div><h2>AI fit</h2><p>${reviewed.length} of ${jobs.length} matches reviewed</p></div><span class="tag">Optional</span></div>${fitDist.length ? bars(fitDist, reviewed.length) : `<div class="empty-state"><strong>A second opinion, when you want it.</strong><p>Ask your agent to rank your jobs, or run <code>jobsweep rank</code> with your own model key. Your search works without AI.</p></div>`}</section>
</div>
<footer class="page-footer"><span>Made for your next move. Stored locally.</span><span>Export <a href="/api/jobs.csv">CSV</a> · <a href="/api/jobs.json">JSON</a> · <a href="/api/decisions.json">Decisions</a></span></footer>
</main></div>
<script>
const btn=document.getElementById("run"),log=document.getElementById("log"),state=document.getElementById("runstate");
const form=document.getElementById("runform");
document.querySelector('a[href="#search"]').addEventListener("click",()=>{document.getElementById("search").open=true;});
form.onsubmit=async(e)=>{e.preventDefault();btn.disabled=true;log.style.display="block";log.textContent="";state.textContent="running…";
  const fd=new FormData(form);const fields={preset:fd.get("preset"),cities:fd.get("cities"),minTc:fd.get("minTc"),maxYoe:fd.get("maxYoe"),days:fd.get("days"),remote:fd.get("remote"),sources:fd.getAll("sources"),new:fd.get("new")==="on",save:fd.get("save")==="on"};
  const r=await fetch("/api/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(fields)});
  if(!r.ok){let m="";try{m=(await r.json()).error||""}catch(x){m=await r.text()}state.textContent="could not start: "+m;btn.disabled=false;return;}
  const es=new EventSource("/api/run/stream");
  es.onmessage=e=>{log.textContent+=e.data+"\\n";log.scrollTop=log.scrollHeight;};
  es.addEventListener("done",e=>{es.close();state.textContent="done — reloading";setTimeout(()=>location.reload(),600);});
  es.onerror=()=>{es.close();state.textContent="stream ended";btn.disabled=false;};};
</script></body></html>`
}
