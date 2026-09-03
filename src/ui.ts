import { themeCss, themeScript, themeSwitcher, type ThemePrefs } from "./theme.ts"
import type { Decision, Job } from "./types.ts"

export interface UiOptions {
  title: string
  /** Shown in the header, e.g. "New York, NY · ≥$200k · ≤3 yrs · 14 d". */
  subtitle: string
  date: string
  /** Comp floor drawn as a tick on every band bar; null hides the tick. */
  floor: number | null
  skills: string[]
  /** Metro test for the NYC/Remote toggle — jobs whose location matches the search city. */
  isLocal: (j: Job) => boolean
  /** Ids to badge and float to the top under "Picks first" sorting. */
  picks?: Set<string>
  /** localStorage key; change it to start a fresh board for the same data. */
  storageKey: string
  /** Marks already stored server-side (when served by `jobsweep serve`); seeds the page state. */
  decisions?: Record<string, Decision>
  /** When served over HTTP, every mark/note is POSTed to /api/decisions as well as kept in localStorage. */
  serverSync?: boolean
  theme?: ThemePrefs
}

interface UiJob {
  id: string
  title: string
  company: string | null
  location: string | null
  url: string
  source: Job["source"]
  posted: string | null
  min: number | null
  max: number | null
  est: boolean
  yoe: number | null
  level: string
  fit: string[]
  local: boolean
  pick: boolean
  desc: string
  ai: { fit: number; reason: string; dealbreakers: string[]; emphasize: string[] } | null
}

const CSS = `
:root{--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:14px/1.45 var(--sans);color:var(--ink);background:var(--bg);display:grid;grid-template-rows:auto 1fr;height:100vh}
header{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--rule)}
header h1{font-size:15px;font-weight:600;margin:0 8px 0 0;letter-spacing:-.01em}
header .meta{color:var(--mute);font-size:12px}
.f{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute)}
.f select,.f input[type=search]{font:inherit;color:var(--ink);border:1px solid var(--rule);background:var(--panel);border-radius:4px;padding:4px 6px}
.f input[type=search]{width:180px}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.seg button{font:inherit;font-size:12px;border:0;background:var(--panel);color:var(--mute);padding:4px 9px;cursor:pointer;border-right:1px solid var(--rule)}
.seg button:last-child{border-right:0}.seg button[aria-pressed=true]{background:var(--ink);color:var(--bg)}
.counts{margin-left:auto;display:flex;gap:14px;font-family:var(--mono);font-size:12px;color:var(--mute)}
.counts b{color:var(--ink);font-weight:600}
main{display:grid;grid-template-columns:minmax(420px,1fr) minmax(420px,1.1fr);min-height:0}
#list{overflow:auto;border-right:1px solid var(--rule);background:var(--panel)}
.row{display:grid;grid-template-columns:8px 1fr 150px 56px 46px;gap:0 12px;align-items:center;padding:9px 14px 9px 10px;border-bottom:1px solid var(--rule);cursor:pointer}
.row:hover{background:color-mix(in srgb,var(--sel) 50%,var(--panel))}.row[aria-selected=true]{background:var(--sel)}
.row .st{width:4px;height:36px;border-radius:2px;background:transparent}
.row[data-s=apply] .st{background:var(--apply)}.row[data-s=maybe] .st{background:var(--maybe)}.row[data-s=skip] .st{background:var(--skip)}.row[data-s=applied] .st{background:var(--done)}
.row[data-s=skip] .t,.row[data-s=skip] .c{color:var(--mute)}
.t{font-weight:600;letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t .pk{font-family:var(--mono);font-size:10px;color:var(--apply);border:1px solid var(--apply);border-radius:3px;padding:0 4px;margin-left:6px;vertical-align:1px}
.c{color:var(--mute);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.band{position:relative;height:36px}
.band .rail{position:absolute;left:0;right:0;top:17px;height:2px;background:var(--rule)}
.band .floor{position:absolute;top:11px;width:1px;height:14px;background:var(--ink);opacity:.55}
.band .bar{position:absolute;top:14px;height:8px;background:var(--ink);border-radius:2px}
.band .bar.est{background:repeating-linear-gradient(90deg,var(--mute) 0 3px,transparent 3px 6px)}
.band .lab{position:absolute;top:24px;font-family:var(--mono);font-size:10.5px;color:var(--mute);white-space:nowrap}
.band .none{position:absolute;top:10px;font-family:var(--mono);font-size:11px;color:var(--mute)}
.ai{font-family:var(--mono);font-size:11px;color:var(--panel);background:var(--mute);border-radius:3px;padding:1px 5px;margin-left:6px;vertical-align:1px}
.ai[data-f="5"],.ai[data-f="4"]{background:var(--apply)}.ai[data-f="3"]{background:var(--maybe)}
.aibox{border:1px solid var(--rule);border-left:3px solid var(--ink);border-radius:5px;padding:10px 12px;margin:0 0 16px;max-width:72ch;font-size:13.5px}
.aibox b{font-weight:600}.aibox ul{margin:6px 0 0;padding-left:18px}.aibox .lab{font-family:var(--mono);font-size:11px;color:var(--mute);margin-right:6px}
.y,.fi{font-family:var(--mono);font-size:12px;color:var(--mute);text-align:right;font-variant-numeric:tabular-nums}
.y b,.fi b{color:var(--ink);font-weight:500}
#detail{overflow:auto;padding:22px 28px 60px}
#detail .empty{color:var(--mute);margin-top:40vh;text-align:center}
.dh h2{margin:0;font-size:20px;font-weight:650;letter-spacing:-.015em;line-height:1.2}
.dh .co{color:var(--mute);margin-top:4px;font-size:14px}
.facts{display:grid;grid-template-columns:repeat(4,auto);gap:8px 22px;margin:16px 0;font-family:var(--mono);font-size:12px;color:var(--mute)}
.facts b{display:block;color:var(--ink);font-weight:500;font-size:13px;margin-top:2px}
.acts{display:flex;gap:8px;margin:14px 0 18px;flex-wrap:wrap}
.acts button,.acts a{font:inherit;font-size:13px;padding:7px 12px;border-radius:5px;border:1px solid var(--rule);background:var(--panel);color:var(--ink);cursor:pointer;text-decoration:none}
.acts a.open{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.acts button[data-s=apply]{border-color:var(--apply);color:var(--apply)}.acts button[data-s=maybe]{border-color:var(--maybe);color:var(--maybe)}
.acts button[data-s=applied]{border-color:var(--done);color:var(--done)}
.acts button[aria-pressed=true]{color:var(--panel)}.acts button[data-s=apply][aria-pressed=true]{background:var(--apply)}.acts button[data-s=maybe][aria-pressed=true]{background:var(--maybe)}
.acts button[data-s=skip][aria-pressed=true]{background:var(--skip);border-color:var(--skip)}.acts button[data-s=applied][aria-pressed=true]{background:var(--done)}
.acts kbd{font-family:var(--mono);font-size:10px;opacity:.6;margin-left:5px}
.skills{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px}
.skills span{font-family:var(--mono);font-size:11px;padding:2px 6px;border:1px solid var(--rule);border-radius:3px;color:var(--mute)}
.skills span.hit{border-color:var(--ink);color:var(--ink)}
.desc{white-space:pre-wrap;font-size:13.5px;line-height:1.55;max-width:72ch;color:var(--ink);opacity:.92}
.desc mark{background:color-mix(in srgb,var(--maybe) 22%,var(--panel));color:inherit;padding:0 1px}
.note textarea{width:100%;max-width:72ch;font:inherit;font-size:13px;border:1px solid var(--rule);border-radius:5px;padding:8px;min-height:60px;resize:vertical}
footer{position:fixed;bottom:0;right:0;left:0;padding:6px 16px;font-family:var(--mono);font-size:11px;color:var(--mute);background:var(--panel);border-top:1px solid var(--rule);display:flex;gap:18px}
footer a{color:var(--mute)}
:focus-visible{outline:2px solid var(--apply);outline-offset:1px}
@media (max-width:900px){main{grid-template-columns:1fr}#detail{display:none}#detail.show{display:block}}
`

// The page script is plain JS kept as a string so the whole page ships as one file with no build step.
const SCRIPT = `
const save=(id)=>{localStorage.setItem(KEY,JSON.stringify(state));if(SYNC&&id)fetch("/api/decisions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status:state[id]?.s||"",note:state[id]?.n||""})}).catch(()=>{});};
const k=n=>"$"+Math.round(n/1000)+"k";
const SRC={linkedin:"LinkedIn",greenhouse:"Greenhouse",lever:"Lever",ashby:"Ashby",adzuna:"Adzuna",freehire:"freehire"};
const LO=100000,HI=400000,pct=v=>Math.max(0,Math.min(100,(v-LO)/(HI-LO)*100));
const HAS_AI=JOBS.some(j=>j.ai);
const ui={where:"all",comp:"all",status:"todo",fit:0,sort:HAS_AI?"ai":HAS_PICKS?"pick":"comp",q:""};
let selected=null;
const st=id=>state[id]?.s||"";
function visible(){
  const q=ui.q.toLowerCase();
  return JOBS.filter(j=>{
    if(ui.where==="local"&&!j.local)return false;if(ui.where==="remote"&&j.local)return false;
    const hasComp=j.max!=null||j.min!=null;if(ui.comp==="posted"&&!hasComp)return false;if(ui.comp==="unknown"&&hasComp)return false;
    const s=st(j.id);if(ui.status==="todo"&&s)return false;if(ui.status!=="todo"&&ui.status!=="all"&&s!==ui.status)return false;
    if(j.fit.length<ui.fit)return false;
    if(q&&!(j.title+" "+j.company+" "+j.location+" "+j.desc).toLowerCase().includes(q))return false;
    return true;
  }).sort((a,b)=>{
    const c=j=>j.max??j.min??0;
    if(ui.sort==="ai"){const d=(b.ai?.fit??0)-(a.ai?.fit??0);if(d)return d;}
    if(ui.sort==="pick"&&a.pick!==b.pick)return a.pick?-1:1;
    if(ui.sort==="fit"){const d=b.fit.length-a.fit.length;if(d)return d;}
    if(ui.sort==="posted")return (b.posted||"").localeCompare(a.posted||"");
    if(ui.sort==="company")return (a.company||"").localeCompare(b.company||"");
    return c(b)-c(a)||b.fit.length-a.fit.length;
  });
}
function band(j){
  if(j.max==null&&j.min==null)return '<div class="band"><span class="none">comp not posted</span></div>';
  const lo=j.min??j.max,hi=j.max??j.min;
  const floor=FLOOR==null?"":'<div class="floor" style="left:'+pct(FLOOR)+'%"></div>';
  return '<div class="band"><div class="rail"></div>'+floor+'<div class="bar'+(j.est?" est":"")+'" style="left:'+pct(lo)+'%;width:'+Math.max(1.5,pct(hi)-pct(lo))+'%"></div><span class="lab" style="left:'+pct(lo)+'%">'+(lo===hi?k(hi):k(lo)+"–"+k(hi))+(j.est?" est":"")+'</span></div>';
}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function hl(text){let h=esc(text);for(const s of SKILLS){h=h.replace(new RegExp("(?<![A-Za-z0-9+#])("+s.replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&")+")(?![A-Za-z0-9])","gi"),"<mark>$1</mark>");}return h;}
function renderList(){
  const list=document.getElementById("list");const rows=visible();
  list.innerHTML=rows.map(j=>'<div class="row" role="option" tabindex="-1" data-id="'+esc(j.id)+'" data-s="'+st(j.id)+'" aria-selected="'+(j.id===selected)+'">'
    +'<div class="st"></div><div><div class="t">'+esc(j.title)+(j.ai?'<span class="ai" data-f="'+j.ai.fit+'">'+j.ai.fit+'/5</span>':"")+(j.pick?'<span class="pk">pick</span>':"")+'</div><div class="c">'+esc(j.company||"—")+' · '+esc(j.location||"—")+'</div></div>'
    +band(j)+'<div class="y">'+(j.yoe!=null?"<b>"+j.yoe+"+</b> yrs":"~"+j.level)+'</div><div class="fi"><b>'+j.fit.length+'</b>/'+SKILLS.length+'</div></div>').join("");
  document.getElementById("shown").textContent=rows.length+" shown";
  const c={apply:0,maybe:0,applied:0,skip:0};for(const j of JOBS){const s=st(j.id);if(s)c[s]++;}
  document.getElementById("counts").innerHTML='<span><b>'+(JOBS.length-c.apply-c.maybe-c.applied-c.skip)+'</b> to review</span><span><b>'+c.apply+'</b> apply</span><span><b>'+c.maybe+'</b> maybe</span><span><b>'+c.applied+'</b> applied</span><span><b>'+c.skip+'</b> skipped</span>';
  return rows;
}
function renderDetail(){
  const d=document.getElementById("detail");const j=JOBS.find(x=>x.id===selected);
  if(!j){d.innerHTML='<div class="empty">Select a posting.</div>';return;}
  const s=st(j.id);const comp=j.max==null&&j.min==null?"not posted":(j.min!=null&&j.max!=null?k(j.min)+"–"+k(j.max):k(j.max??j.min))+(j.est?" (est.)":"");
  d.innerHTML='<div class="dh"><h2>'+esc(j.title)+'</h2><div class="co">'+esc(j.company||"—")+' · '+esc(j.location||"—")+'</div></div>'
   +'<div class="facts"><div>Comp<b>'+comp+'</b></div><div>Years required<b>'+(j.yoe!=null?j.yoe+"+ stated":"not stated (~"+j.level+" by title)")+'</b></div><div>Posted<b>'+(j.posted||"—")+'</b></div><div>Source<b>'+SRC[j.source]+'</b></div></div>'
   +'<div class="acts"><a class="open" href="'+esc(j.url)+'" target="_blank" rel="noopener">Open posting<kbd>o</kbd></a>'
   +'<button data-s="apply" aria-pressed="'+(s==="apply")+'">Apply<kbd>a</kbd></button><button data-s="maybe" aria-pressed="'+(s==="maybe")+'">Maybe<kbd>m</kbd></button><button data-s="applied" aria-pressed="'+(s==="applied")+'">Applied<kbd>d</kbd></button><button data-s="skip" aria-pressed="'+(s==="skip")+'">Skip<kbd>x</kbd></button></div>'
   +(j.ai?'<div class="aibox"><span class="lab">AI fit</span><b>'+j.ai.fit+'/5 '+({5:"apply today",4:"apply",3:"maybe",2:"unlikely",1:"skip"}[j.ai.fit]||"")+'</b> — '+esc(j.ai.reason)
     +(j.ai.dealbreakers.length?'<ul>'+j.ai.dealbreakers.map(d=>'<li><span class="lab">dealbreaker</span>'+esc(d)+'</li>').join("")+'</ul>':"")
     +(j.ai.emphasize.length?'<ul>'+j.ai.emphasize.map(d=>'<li><span class="lab">lead with</span>'+esc(d)+'</li>').join("")+'</ul>':"")+'</div>':"")
   +'<div class="skills">'+SKILLS.map(sk=>'<span class="'+(j.fit.includes(sk)?"hit":"")+'">'+esc(sk)+'</span>').join("")+'</div>'
   +'<div class="note"><textarea placeholder="Notes for this posting">'+esc(state[j.id]?.n||"")+'</textarea></div>'
   +'<div class="desc" style="margin-top:16px">'+(j.desc?hl(j.desc):"<span style='color:var(--mute)'>No description captured — open the posting.</span>")+'</div>';
  d.scrollTop=0;
  d.querySelectorAll(".acts button").forEach(b=>b.onclick=()=>setStatus(j.id,b.dataset.s));
  d.querySelector("textarea").oninput=e=>{state[j.id]={...(state[j.id]||{}),n:e.target.value};save(j.id);};
}
function setStatus(id,s){const before=visible();const i=before.findIndex(r=>r.id===id);
  const cur=state[id]||{};state[id]={...cur,s:cur.s===s?"":s,t:Date.now()};save(id);
  const rows=renderList();renderDetail();
  if(!rows.some(r=>r.id===id)){const next=rows[i]??rows[i-1];if(next)select(next.id);}
}
function select(id){selected=id;document.querySelectorAll(".row").forEach(r=>r.setAttribute("aria-selected",r.dataset.id===id));renderDetail();
  const el=document.querySelector('.row[data-id="'+CSS.escape(id)+'"]');el&&el.scrollIntoView({block:"nearest"});document.getElementById("detail").classList.add("show");}
function move(d){const rows=visible();if(!rows.length)return;const i=rows.findIndex(r=>r.id===selected);select(rows[Math.max(0,Math.min(rows.length-1,(i<0?0:i+d)))].id);}
document.getElementById("list").addEventListener("click",e=>{const r=e.target.closest(".row");if(r)select(r.dataset.id);});
for(const g of ["where","comp","status"]){document.getElementById(g).addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;ui[g]=b.dataset.v;[...b.parentNode.children].forEach(x=>x.setAttribute("aria-pressed",x===b));renderList();});}
document.getElementById("fit").onchange=e=>{ui.fit=+e.target.value;renderList();};
document.getElementById("sort").onchange=e=>{ui.sort=e.target.value;renderList();};
document.getElementById("q").oninput=e=>{ui.q=e.target.value;renderList();};
document.addEventListener("keydown",e=>{
  if(e.target.matches("input,textarea,select")){if(e.key==="Escape")e.target.blur();return;}
  const j=JOBS.find(x=>x.id===selected);
  if(e.key==="j"||e.key==="ArrowDown"){e.preventDefault();move(1);}else if(e.key==="k"||e.key==="ArrowUp"){e.preventDefault();move(-1);}
  else if(e.key==="/"){e.preventDefault();document.getElementById("q").focus();}
  else if(j&&e.key==="a")setStatus(j.id,"apply");else if(j&&e.key==="m")setStatus(j.id,"maybe");else if(j&&e.key==="x")setStatus(j.id,"skip");else if(j&&e.key==="d")setStatus(j.id,"applied");
  else if(j&&(e.key==="o"||e.key==="Enter"))window.open(j.url,"_blank","noopener");
});
document.getElementById("export").onclick=e=>{e.preventDefault();const out=JOBS.filter(j=>state[j.id]?.s).map(j=>({status:state[j.id].s,title:j.title,company:j.company,comp:j.max?k(j.max):null,url:j.url,note:state[j.id].n||""}));
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:"application/json"}));a.download="job-decisions.json";a.click();};
document.getElementById("reset").onclick=e=>{e.preventDefault();if(confirm("Clear every apply/maybe/skip/applied mark and note?")){const ids=Object.keys(state);state={};localStorage.setItem(KEY,"{}");if(SYNC)for(const id of ids)fetch("/api/decisions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status:"",note:""})}).catch(()=>{});renderList();renderDetail();}};
if(HAS_PICKS){document.getElementById("sort").insertAdjacentHTML("afterbegin",'<option value="pick">Picks first</option>');document.getElementById("sort").value="pick";}
if(HAS_AI){document.getElementById("sort").insertAdjacentHTML("afterbegin",'<option value="ai">AI fit</option>');document.getElementById("sort").value="ai";}
const first=renderList();if(first.length)select(first[0].id);
`

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
}

/** One self-contained HTML page: data embedded, decisions in localStorage, no network needed. */
export function renderUi(jobs: Job[], o: UiOptions): string {
  const data: UiJob[] = jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company,
    location: j.location,
    url: /^https?:\/\//i.test(j.url) ? j.url : "",
    source: j.source,
    posted: j.postedAt?.slice(0, 10) ?? null,
    min: j.salary?.min ?? null,
    max: j.salary?.max ?? null,
    est: j.salary?.kind === "predicted",
    yoe: j.yoeMin,
    level: j.level,
    fit: j.fit?.matched ?? [],
    local: o.isLocal(j),
    pick: o.picks?.has(j.id) ?? false,
    desc: (j.description ?? "").slice(0, 12_000),
    ai: j.ai ? { fit: j.ai.fit, reason: j.ai.reason, dealbreakers: j.ai.dealbreakers, emphasize: j.ai.emphasize } : null,
  }))
  // `</script>` inside a description would end the data block early.
  const json = (v: unknown) => JSON.stringify(v).replace(/<\//g, "<\\/")
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(o.title)}</title>${themeScript(o.theme ?? {})}<style>${themeCss()}${CSS}</style></head><body>
<header>
  <h1>${escHtml(o.title)}</h1><span class="meta">${escHtml(o.subtitle)}</span>
  <div class="f"><span class="seg" id="where"><button data-v="all" aria-pressed="true">All</button><button data-v="local">Local</button><button data-v="remote">Remote</button></span></div>
  <div class="f"><span class="seg" id="comp"><button data-v="all" aria-pressed="true">Any comp</button><button data-v="posted">Posted</button><button data-v="unknown">Unknown</button></span></div>
  <div class="f"><span class="seg" id="status"><button data-v="todo" aria-pressed="true">To review</button><button data-v="apply">Apply</button><button data-v="maybe">Maybe</button><button data-v="applied">Applied</button><button data-v="skip">Skipped</button><button data-v="all">All</button></span></div>
  <div class="f"><label>Fit ≥ <select id="fit"><option>0</option><option>2</option><option>4</option><option>6</option></select></label></div>
  <div class="f"><label>Sort <select id="sort"><option value="comp">Comp</option><option value="fit">Fit</option><option value="posted">Posted</option><option value="company">Company</option></select></label></div>
  <div class="f"><input id="q" type="search" placeholder="Search title, company, text"></div>
  <div class="counts" id="counts"></div>
</header>
<main>
  <section id="list" role="listbox" aria-label="Postings"></section>
  <section id="detail"><div class="empty">Select a posting. ↑↓ or j/k to move · a apply · m maybe · x skip · d applied · o open in new tab</div></section>
</main>
<footer><span id="shown"></span>${themeSwitcher()}${o.serverSync ? '<a href="/">Dashboard</a>' : ""}<span>a apply · m maybe · x skip · d applied · o open · / search</span><a href="#" id="export">Export decisions (JSON)</a><a href="#" id="reset">Clear decisions</a></footer>
<script>
const JOBS=${json(data)};
const KEY=${json(o.storageKey)};
const FLOOR=${json(o.floor)};
const SKILLS=${json(o.skills)};
const HAS_PICKS=${json(!!o.picks?.size)};
const SYNC=${json(!!o.serverSync)};
const SERVER_STATE=${json(Object.fromEntries(Object.entries(o.decisions ?? {}).map(([id, d]) => [id, { s: d.status, n: d.note, t: d.updatedAt }])))};
// Served: the server is the only store, so a mark cleared there can't resurrect from a stale browser copy.
// Standalone file: localStorage is the store.
let state=SYNC?SERVER_STATE:JSON.parse(localStorage.getItem(KEY)||"{}");
${SCRIPT}
</script></body></html>`
}
