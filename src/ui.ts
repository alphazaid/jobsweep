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
*{box-sizing:border-box}html,body{margin:0;height:100%}body{font:14px/1.5 var(--sans);color:var(--ink);background:var(--bg);display:grid;grid-template-rows:auto minmax(0,1fr) auto;height:100vh;height:100dvh}
button,input,select,textarea{font:inherit;color:var(--ink);background:var(--panel)}button,a,input,select,summary{-webkit-tap-highlight-color:transparent}button{cursor:pointer}a{color:inherit}
header{display:flex;align-items:center;gap:24px;padding:18px 24px;background:var(--panel);border-bottom:1px solid var(--rule);min-width:0}
.brand{display:flex;align-items:center;gap:9px;text-decoration:none;font-size:20px;letter-spacing:-.8px;font-weight:700;flex-shrink:0}.brand-mark{display:grid;place-items:center;width:27px;height:27px;border-radius:6px;background:var(--ink);color:var(--panel);font:600 14px var(--mono);letter-spacing:-3px;padding-right:3px}
.page-title{border-left:1px solid var(--rule);padding-left:24px;min-width:0}header h1{font-size:14px;font-weight:600;margin:0}header .meta{color:var(--mute);font-size:11px;overflow-wrap:anywhere}.back{font-size:12px;color:var(--mute);text-decoration:none;white-space:nowrap}.back:hover{color:var(--ink)}
.theme{margin-left:auto;gap:4px}.theme select,.theme button{padding:6px 8px;border-radius:5px}.theme button{text-transform:capitalize}
main{display:grid;grid-template-columns:196px minmax(300px,.9fr) minmax(0,1.2fr);min-height:0}
.filters{padding:26px 16px;background:var(--panel);border-right:1px solid var(--rule);overflow:auto}.filters summary{display:none}.filter-content{display:grid;gap:28px}.filter-label,.eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.11em;font-weight:600;color:var(--mute)}.filter-label{display:block;margin-bottom:10px}
.seg{display:flex;flex-wrap:wrap;gap:4px}.seg button{font:500 11px var(--sans);border:1px solid var(--rule);background:var(--panel);color:var(--mute);padding:8px 9px;border-radius:5px}.seg button:hover{color:var(--ink);border-color:var(--mute)}.seg button[aria-pressed=true]{color:var(--accent);background:var(--sel);border-color:var(--rule)}
#status{display:grid;gap:4px}#status button{display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:10px 12px;border-color:transparent;text-align:left}#status button[aria-pressed=true]{font-weight:600}#status .count{font:11px var(--mono)}.filter-note{font-size:11px;line-height:1.7;color:var(--mute);margin:0}
.list-pane{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--rule)}
.list-toolbar{padding:22px 20px 16px;border-bottom:1px solid var(--rule)}.list-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}.list-heading h2{font-size:16px;letter-spacing:-.3px;margin:0;font-weight:600}#shown{font:11px var(--mono);color:var(--mute);white-space:nowrap}
.search-wrap{position:relative;display:block}.search-wrap input{width:100%;padding:10px 34px 10px 12px;border:1px solid var(--rule);border-radius:6px;background:var(--bg);font-size:12px;min-width:0}.search-wrap kbd{position:absolute;right:12px;top:10px;color:var(--mute);font:11px var(--mono);pointer-events:none}
.list-options{display:flex;gap:14px;justify-content:space-between;align-items:center;margin-top:12px}.list-options label{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mute)}.list-options select{font-size:11px;padding:5px;border:1px solid var(--rule);border-radius:4px;max-width:145px}
#list{overflow:auto;min-height:0;flex:1;scroll-padding:10px}
.row{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:20px;border-bottom:1px solid var(--rule);cursor:pointer;border-left:3px solid transparent}.row:hover{background:var(--bg)}.row[aria-selected=true]{background:var(--sel);border-left-color:var(--accent)}
.row[data-s=skip] .t{color:var(--mute)}.row-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.job-identity{min-width:0}.t{font-size:13px;font-weight:600;letter-spacing:-.1px;line-height:1.5;overflow-wrap:anywhere}.c{color:var(--ink);font-size:12px;margin-top:4px;overflow-wrap:anywhere}.location{color:var(--mute);font-size:11px;margin-top:2px;overflow-wrap:anywhere}
.pk,.ai,.decision-badge{font:10px var(--mono);border:1px solid var(--rule);border-radius:4px;padding:3px 5px;white-space:nowrap;color:var(--mute)}.pk{color:var(--accent)}.ai{color:var(--accent);background:var(--panel)}.row-badges{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;flex-shrink:0;max-width:100px}
.row-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px}.comp-label{font:500 12px var(--mono);color:var(--ink)}.row-meta{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:6px;font-size:10px;color:var(--mute)}.decision-badge[data-s=apply]{color:var(--apply)}.decision-badge[data-s=maybe]{color:var(--maybe)}.decision-badge[data-s=applied]{color:var(--done)}
.band{position:relative;width:84px;height:12px;flex-shrink:0}.band .rail{position:absolute;left:0;right:0;top:5px;height:2px;background:var(--rule)}.band .floor{position:absolute;top:1px;width:1px;height:10px;background:var(--mute)}.band .bar{position:absolute;top:3px;height:6px;background:var(--accent);border-radius:2px}.band .bar.est{background:var(--mute)}
#detail{min-width:0;min-height:0;overflow:auto;padding:24px 30px 44px;scroll-padding-top:20px}.detail-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:30px;color:var(--mute);font-size:11px}.detail-nav .navigation{display:flex;gap:6px}.detail-nav button{font-size:11px;border:1px solid var(--rule);border-radius:5px;padding:6px 9px}.detail-nav button:disabled{opacity:.4;cursor:default}.detail-back{display:none}
.dh h2{margin:8px 0;font-size:26px;line-height:1.25;letter-spacing:-.7px;font-weight:650;overflow-wrap:anywhere}.dh .co{font-size:13px;color:var(--mute);overflow-wrap:anywhere}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:24px 0;padding:20px;border:1px solid var(--rule);border-radius:8px;background:var(--panel);font-size:11px;color:var(--mute)}.facts b{display:block;color:var(--ink);font-weight:500;font-size:13px;margin-top:4px;overflow-wrap:anywhere}
.acts{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0 24px}.acts button,.acts a{font-size:12px;padding:9px 12px;border-radius:5px;border:1px solid var(--rule);background:var(--panel);color:var(--ink);text-decoration:none}.acts a.open{background:var(--ink);color:var(--panel);border-color:var(--ink)}.acts button:hover{border-color:var(--mute)}
.acts button[data-s=apply][aria-pressed=true]{background:var(--apply);border-color:var(--apply);color:var(--panel)}.acts button[data-s=maybe][aria-pressed=true]{background:var(--maybe);border-color:var(--maybe);color:var(--panel)}.acts button[data-s=skip][aria-pressed=true]{background:var(--skip);border-color:var(--skip);color:var(--panel)}.acts button[data-s=applied][aria-pressed=true]{background:var(--done);border-color:var(--done);color:var(--panel)}
.acts kbd{font-family:var(--mono);font-size:10px;opacity:.65;margin-left:6px}
.detail-section{margin-top:26px}.detail-section h3{font-size:12px;font-weight:600;margin:0 0 12px}.skills{display:flex;flex-wrap:wrap;gap:6px}.skills span{font-size:11px;padding:4px 8px;border:1px solid var(--rule);border-radius:4px;color:var(--mute);background:var(--panel)}.skills span.hit{color:var(--accent);border-color:var(--accent);background:var(--sel)}
.aibox{border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:6px;padding:16px;background:var(--panel);font-size:12px;margin:24px 0}.aibox b{font-weight:600}.aibox ul{margin:10px 0 0;padding-left:18px}.aibox .lab{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin-right:6px}
.desc{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8;max-width:76ch}.desc mark{background:var(--sel);color:var(--accent);padding:0 2px}
.note label{display:block;font-size:12px;font-weight:600;margin-bottom:10px}.note textarea{width:100%;font-size:12px;border:1px solid var(--rule);border-radius:6px;padding:12px;min-height:84px;resize:vertical;background:var(--panel);color:var(--ink)}.note p{color:var(--mute);font-size:10px;margin:5px 0 0}
.empty{padding:48px 24px;text-align:center;color:var(--mute);font-size:12px}.empty strong{display:block;color:var(--ink);font-size:16px;font-weight:500;margin-bottom:8px}.empty p{margin:0;line-height:1.8}
footer{padding:11px 20px;color:var(--mute);background:var(--panel);border-top:1px solid var(--rule);display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:10px}footer .links{display:flex;gap:14px;flex-wrap:wrap}footer a{color:var(--mute);text-underline-offset:3px}.shortcuts{display:flex;gap:14px;flex-wrap:wrap}kbd{font-family:var(--mono);font-size:10px}.storage-label{color:var(--mute)}
:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
@media(min-width:1500px){main{grid-template-columns:212px minmax(380px,.85fr) minmax(0,1.2fr)}#detail{padding:28px 48px 48px}.row{padding:22px 24px}}
@media(max-width:1100px){main{grid-template-columns:170px minmax(280px,.9fr) minmax(0,1fr)}header{padding:14px 18px;gap:16px}.page-title{padding-left:16px}#detail{padding:20px}.row{padding:17px}.theme select,.theme button{padding:5px 6px}.dh h2{font-size:23px}}
@media(max-width:1000px){main{grid-template-columns:minmax(280px,.85fr) minmax(0,1.15fr);grid-template-rows:auto minmax(0,1fr)}.filters{grid-column:1/-1;padding:0;border-right:0;border-bottom:1px solid var(--rule);overflow:visible}.filters summary{display:block;padding:12px 20px;cursor:pointer;color:var(--mute);font-size:12px}.filters summary:after{content:" +";float:right}.filters details[open] summary:after{content:" −"}.filter-content{grid-template-columns:1.4fr 1fr 1fr;gap:18px;padding:8px 20px 18px}.filter-note{display:none}#status{display:flex;flex-wrap:wrap;gap:4px}#status button{padding:7px 8px;gap:8px;font-size:11px}.back{display:none}.shortcuts{gap:10px}footer{padding:10px 16px}}
@media(max-width:760px){header{flex-wrap:wrap;gap:10px 16px;padding:12px 16px}.brand{font-size:18px}.page-title{flex:1}.theme{width:100%;margin:0;justify-content:flex-start}.theme select{margin-right:auto}main{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}.filter-content{grid-template-columns:1fr 1fr}.pipeline{grid-column:1/-1}.list-pane{border-right:0}#detail{display:none;padding:18px 20px 36px}.detail-open main{grid-template-rows:minmax(0,1fr)}.detail-open .filters,.detail-open .list-pane{display:none}.detail-open #detail{display:block}.detail-back{display:inline-block}.detail-nav{margin-bottom:22px}.detail-nav .eyebrow{display:none}.dh h2{font-size:25px}.list-toolbar{padding:16px 20px}.row{padding:18px 20px}.shortcuts,.storage-label{display:none}footer{padding:10px 16px}.facts{gap:16px;padding:16px}.acts button,.acts a{padding:10px 12px}.filter-label{font-size:9px}}
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
  if(j.max==null&&j.min==null)return "";
  const lo=j.min??j.max,hi=j.max??j.min;
  const floor=FLOOR==null?"":'<div class="floor" style="left:'+pct(FLOOR)+'%"></div>';
  return '<div class="band" aria-hidden="true"><div class="rail"></div>'+floor+'<div class="bar'+(j.est?" est":"")+'" style="left:'+Math.min(98.5,pct(lo))+'%;width:'+Math.max(1.5,pct(hi)-pct(lo))+'%"></div></div>';
}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function hl(text){let h=esc(text);for(const s of SKILLS){h=h.replace(new RegExp("(?<![A-Za-z0-9+#])("+s.replace(/[.*+?^\${}()|[\\]\\\\]/g,"\\\\$&")+")(?![A-Za-z0-9])","gi"),"<mark>$1</mark>");}return h;}
function renderList(){
  const list=document.getElementById("list");const rows=visible();
  if(!rows.some(j=>j.id===selected))selected=rows[0]?.id??null;
  list.innerHTML=rows.length?rows.map((j,i)=>'<div class="row" id="job-row-'+i+'" role="option" tabindex="-1" data-id="'+esc(j.id)+'" data-s="'+st(j.id)+'" aria-selected="'+(j.id===selected)+'">'
    +'<div class="row-top"><div class="job-identity"><div class="t">'+esc(j.title)+'</div><div class="c">'+esc(j.company||"Company not listed")+'</div><div class="location">'+esc(j.location||"Location not listed")+'</div></div><div class="row-badges">'+(j.ai?'<span class="ai">AI '+j.ai.fit+'/5</span>':"")+(j.pick?'<span class="pk">Pick</span>':"")+'</div></div>'
    +'<div class="row-bottom"><div><div class="comp-label">'+(j.max==null&&j.min==null?"Comp not posted":(j.min!=null&&j.max!=null&&j.min!==j.max?k(j.min)+"–"+k(j.max):k(j.max??j.min))+(j.est?" est.":""))+'</div><div class="row-meta"><span>'+(j.yoe!=null?j.yoe+"+ years":"~"+esc(j.level))+'</span>'+(SKILLS.length?'<span>'+j.fit.length+'/'+SKILLS.length+' skills</span>':"")+(st(j.id)?'<span class="decision-badge" data-s="'+st(j.id)+'">'+({apply:"Apply",maybe:"Maybe",applied:"Applied",skip:"Skipped"}[st(j.id)])+'</span>':"")+'</div></div>'+band(j)+'</div></div>').join(""):'<div class="empty"><strong>No jobs in this view.</strong><p>Try a different pipeline, loosen your filters, or clear your search.</p></div>';
  document.getElementById("shown").textContent=rows.length+" shown";
  const c={apply:0,maybe:0,applied:0,skip:0};for(const j of JOBS){const s=st(j.id);if(s)c[s]++;}
  const totals={...c,todo:JOBS.length-c.apply-c.maybe-c.applied-c.skip,all:JOBS.length};
  document.querySelectorAll("#status button").forEach(b=>b.querySelector(".count").textContent=totals[b.dataset.v]);
  const active=list.querySelector('[aria-selected="true"]');if(active)list.setAttribute("aria-activedescendant",active.id);else list.removeAttribute("aria-activedescendant");
  renderDetail(rows);
  if(!rows.length)document.body.classList.remove("detail-open");
  return rows;
}
function renderDetail(rows=visible()){
  const d=document.getElementById("detail");const j=JOBS.find(x=>x.id===selected);
  if(!j){d.innerHTML='<div class="empty"><strong>Room for your next move.</strong><p>Select a job from the list. Its details, notes, and decisions will appear here.</p></div>';return;}
  const index=rows.findIndex(r=>r.id===selected);
  const s=st(j.id);const comp=j.max==null&&j.min==null?"not posted":(j.min!=null&&j.max!=null?k(j.min)+"–"+k(j.max):k(j.max??j.min))+(j.est?" (est.)":"");
  d.innerHTML='<div class="detail-nav"><button class="detail-back" type="button">← Back to jobs</button><span class="eyebrow">Posting details</span><div class="navigation"><button data-move="-1" aria-label="Previous job"'+(index<=0?' disabled':"")+'>←</button><span>'+(index+1)+' of '+rows.length+'</span><button data-move="1" aria-label="Next job"'+(index>=rows.length-1?' disabled':"")+'>→</button></div></div>'
   +'<div class="dh"><div class="eyebrow">'+SRC[j.source]+' · '+(s?({apply:"Marked to apply",maybe:"Considering",applied:"Applied",skip:"Skipped"}[s]):"Awaiting your decision")+'</div><h2>'+esc(j.title)+'</h2><div class="co">'+esc(j.company||"Company not listed")+' · '+esc(j.location||"Location not listed")+'</div></div>'
   +'<div class="facts"><div>Comp<b>'+comp+'</b></div><div>Years required<b>'+(j.yoe!=null?j.yoe+"+ stated":"not stated (~"+j.level+" by title)")+'</b></div><div>Posted<b>'+(j.posted||"—")+'</b></div><div>Source<b>'+SRC[j.source]+'</b></div></div>'
   +'<div class="acts"><a class="open" href="'+esc(j.url)+'" target="_blank" rel="noopener">Open posting<kbd>o</kbd></a>'
   +'<button data-s="apply" aria-pressed="'+(s==="apply")+'">Apply<kbd>a</kbd></button><button data-s="maybe" aria-pressed="'+(s==="maybe")+'">Maybe<kbd>m</kbd></button><button data-s="applied" aria-pressed="'+(s==="applied")+'">Applied<kbd>d</kbd></button><button data-s="skip" aria-pressed="'+(s==="skip")+'">Skip<kbd>x</kbd></button></div>'
   +(j.ai?'<div class="aibox"><span class="lab">AI fit</span><b>'+j.ai.fit+'/5 '+({5:"apply today",4:"apply",3:"maybe",2:"unlikely",1:"skip"}[j.ai.fit]||"")+'</b> — '+esc(j.ai.reason)
     +(j.ai.dealbreakers.length?'<ul>'+j.ai.dealbreakers.map(d=>'<li><span class="lab">dealbreaker</span>'+esc(d)+'</li>').join("")+'</ul>':"")
     +(j.ai.emphasize.length?'<ul>'+j.ai.emphasize.map(d=>'<li><span class="lab">lead with</span>'+esc(d)+'</li>').join("")+'</ul>':"")+'</div>':"")
   +(SKILLS.length?'<section class="detail-section"><h3>Skills · '+j.fit.length+' of '+SKILLS.length+' matched</h3><div class="skills">'+SKILLS.map(sk=>'<span class="'+(j.fit.includes(sk)?"hit":"")+'">'+esc(sk)+'</span>').join("")+'</div></section>':"")
   +'<section class="note detail-section"><label for="job-note">Your notes</label><textarea id="job-note" placeholder="What stands out? What would you ask the recruiter?">'+esc(state[j.id]?.n||"")+'</textarea><p>'+ (SYNC?"Stored on this machine.":"Stored in this browser.")+'</p></section>'
   +'<section class="detail-section"><h3>About the role</h3><div class="desc">'+(j.desc?hl(j.desc):"No description captured. Open the posting for the full details.")+'</div></section>';
  d.scrollTop=0;
  d.querySelectorAll(".acts button").forEach(b=>b.onclick=()=>setStatus(j.id,b.dataset.s));
  d.querySelector("textarea").oninput=e=>{state[j.id]={...(state[j.id]||{}),n:e.target.value};save(j.id);};
  d.querySelector(".detail-back").onclick=backToList;
  d.querySelectorAll("[data-move]").forEach(b=>b.onclick=()=>move(Number(b.dataset.move)));
}
function setStatus(id,s){const before=visible();const i=before.findIndex(r=>r.id===id);
  const cur=state[id]||{};state[id]={...cur,s:cur.s===s?"":s,t:Date.now()};save(id);
  const rows=renderList();
  if(!rows.some(r=>r.id===id)){const next=rows[i]??rows[i-1];if(next)select(next.id);}
}
function backToList(){document.body.classList.remove("detail-open");const list=document.getElementById("list");list.focus({preventScroll:true});list.querySelector('[aria-selected="true"]')?.scrollIntoView({block:"nearest"});}
function select(id){selected=id;document.querySelectorAll(".row").forEach(r=>r.setAttribute("aria-selected",r.dataset.id===id));renderDetail();
  const el=document.querySelector('.row[data-id="'+CSS.escape(id)+'"]');if(el){document.getElementById("list").setAttribute("aria-activedescendant",el.id);el.scrollIntoView({block:"nearest"});}
  document.body.classList.add("detail-open");if(matchMedia("(max-width:760px)").matches)document.getElementById("detail").focus({preventScroll:true});}
function move(d){const rows=visible();if(!rows.length)return;const i=rows.findIndex(r=>r.id===selected);select(rows[Math.max(0,Math.min(rows.length-1,(i<0?0:i+d)))].id);}
document.getElementById("list").addEventListener("click",e=>{const r=e.target.closest(".row");if(r)select(r.dataset.id);});
for(const g of ["where","comp","status"]){document.getElementById(g).addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;ui[g]=b.dataset.v;[...b.parentNode.children].forEach(x=>x.setAttribute("aria-pressed",x===b));renderList();});}
const fitFilter=document.getElementById("fit");if(fitFilter)fitFilter.onchange=e=>{ui.fit=+e.target.value;renderList();};
document.getElementById("sort").onchange=e=>{ui.sort=e.target.value;renderList();};
document.getElementById("q").oninput=e=>{ui.q=e.target.value;renderList();};
document.addEventListener("keydown",e=>{
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.target.matches("input,textarea,select")){if(e.key==="Escape")e.target.blur();return;}
  if(e.key==="Escape"){backToList();return;}
  if(e.target.closest("button,a,summary"))return;
  const j=JOBS.find(x=>x.id===selected);
  if(e.key==="j"||e.key==="ArrowDown"){e.preventDefault();move(1);}else if(e.key==="k"||e.key==="ArrowUp"){e.preventDefault();move(-1);}
  else if(e.key==="/"){e.preventDefault();backToList();document.getElementById("q").focus();}
  else if(j&&e.key==="a")setStatus(j.id,"apply");else if(j&&e.key==="m")setStatus(j.id,"maybe");else if(j&&e.key==="x")setStatus(j.id,"skip");else if(j&&e.key==="d")setStatus(j.id,"applied");
  else if(j&&(e.key==="o"||e.key==="Enter"))window.open(j.url,"_blank","noopener");
});
document.getElementById("export").onclick=e=>{e.preventDefault();const out=JOBS.filter(j=>state[j.id]?.s).map(j=>({status:state[j.id].s,title:j.title,company:j.company,comp:j.max?k(j.max):null,url:j.url,note:state[j.id].n||""}));
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:"application/json"}));a.download="job-decisions.json";a.click();};
document.getElementById("reset").onclick=e=>{e.preventDefault();if(confirm("Clear every apply/maybe/skip/applied mark and note?")){const ids=Object.keys(state);state={};localStorage.setItem(KEY,"{}");if(SYNC)for(const id of ids)fetch("/api/decisions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,status:"",note:""})}).catch(()=>{});renderList();}};
if(HAS_PICKS){document.getElementById("sort").insertAdjacentHTML("afterbegin",'<option value="pick">Picks first</option>');document.getElementById("sort").value="pick";}
if(HAS_AI){document.getElementById("sort").insertAdjacentHTML("afterbegin",'<option value="ai">AI fit</option>');document.getElementById("sort").value="ai";}
const compact=matchMedia("(max-width:1000px)");const filterPanel=document.getElementById("filter-panel");filterPanel.open=!compact.matches;compact.addEventListener("change",e=>{filterPanel.open=!e.matches;});
renderList();
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
  <${o.serverSync ? 'a href="/"' : "span"} class="brand"><span class="brand-mark" aria-hidden="true">//</span>jobsweep</${o.serverSync ? "a" : "span"}>
  <div class="page-title"><h1>Triage</h1><div class="meta">${escHtml(o.subtitle)}</div></div>
  ${o.serverSync ? '<a class="back" href="/">Back to overview</a>' : ""}${themeSwitcher()}
</header>
<main>
  <aside class="filters" aria-label="Posting filters"><details id="filter-panel" open><summary>Pipeline &amp; filters</summary><div class="filter-content">
    <div class="pipeline"><span class="filter-label">Your pipeline</span><div class="seg" id="status" role="group" aria-label="Decision filter"><button data-v="todo" aria-pressed="true">To review <span class="count"></span></button><button data-v="apply">Apply <span class="count"></span></button><button data-v="maybe">Maybe <span class="count"></span></button><button data-v="applied">Applied <span class="count"></span></button><button data-v="skip">Skipped <span class="count"></span></button><button data-v="all">All jobs <span class="count"></span></button></div></div>
    <div><span class="filter-label">Location</span><div class="seg" id="where" role="group" aria-label="Location filter"><button data-v="all" aria-pressed="true">All</button><button data-v="local">Local</button><button data-v="remote">Remote</button></div></div>
    <div><span class="filter-label">Compensation</span><div class="seg" id="comp" role="group" aria-label="Compensation filter"><button data-v="all" aria-pressed="true">Any</button><button data-v="posted">Posted</button><button data-v="unknown">Unknown</button></div></div>
    <p class="filter-note">Your decisions are yours.<br>AI scores are a second opinion, never a mark on your behalf.</p>
  </div></details></aside>
  <section class="list-pane" aria-label="Job browser"><div class="list-toolbar"><div class="list-heading"><h2>Opportunities</h2><span id="shown" aria-live="polite"></span></div>
    <label class="search-wrap"><input id="q" type="search" aria-label="Search jobs" placeholder="Search title, company, or keywords"><kbd aria-hidden="true">/</kbd></label>
    <div class="list-options"><label>Sort by <select id="sort"><option value="comp">Compensation</option>${o.skills.length ? '<option value="fit">Skill match</option>' : ""}<option value="posted">Newest posted</option><option value="company">Company</option></select></label>${o.skills.length ? '<label>Skills ≥ <select id="fit"><option>0</option><option>2</option><option>4</option><option>6</option></select></label>' : ""}</div>
  </div><div id="list" role="listbox" aria-label="Postings" tabindex="0"></div></section>
  <section id="detail" aria-label="Selected posting" tabindex="-1"><div class="empty"><strong>Your next opportunity.</strong><p>Select a job to review its details.</p></div></section>
</main>
<footer><div class="shortcuts"><span><kbd>j k</kbd> navigate</span><span><kbd>a</kbd> apply</span><span><kbd>m</kbd> maybe</span><span><kbd>x</kbd> skip</span><span><kbd>d</kbd> applied</span><span><kbd>o</kbd> open</span><span><kbd>/</kbd> search</span></div><span class="storage-label">${o.serverSync ? "Saved on this machine" : "Offline · saved in this browser"}</span><div class="links">${o.serverSync ? '<a href="/">Overview</a>' : ""}<a href="#" id="export">Export decisions</a><a href="#" id="reset">Clear decisions</a></div></footer>
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
