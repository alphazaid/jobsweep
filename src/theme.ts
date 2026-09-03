// One theme block for every page: a palette (hue family) × a mode (light / dark / system).
// Flat colors only — no gradients, no glow. Choice persists in localStorage and, when the
// profile sets `theme`, starts from that.

export interface Palette {
  name: string
  light: Record<string, string>
  dark: Record<string, string>
}

/** Variables every page uses. `apply/maybe/skip/done` are the mark colors; `sel` is the selected row. */
const V = ["bg", "panel", "ink", "mute", "rule", "accent", "apply", "maybe", "skip", "done", "sel", "code", "codeInk"] as const

export const PALETTES: Record<string, Palette> = {
  graphite: {
    name: "Graphite",
    light: { bg: "#F5F6F8", panel: "#FFFFFF", ink: "#16181D", mute: "#6B7280", rule: "#DDE0E5", accent: "#1D4ED8", apply: "#1D4ED8", maybe: "#B45309", skip: "#6B7280", done: "#047857", sel: "#EEF2FF", code: "#0F1115", codeInk: "#D7DAE0" },
    dark: { bg: "#111318", panel: "#1A1D24", ink: "#E6E8EC", mute: "#8B919C", rule: "#2A2E37", accent: "#7AA2FF", apply: "#7AA2FF", maybe: "#E0A458", skip: "#8B919C", done: "#4ADE9A", sel: "#232838", code: "#0B0D11", codeInk: "#C9CDD4" },
  },
  ocean: {
    name: "Ocean",
    light: { bg: "#F2F6F9", panel: "#FFFFFF", ink: "#0F1F2E", mute: "#5C7186", rule: "#D6E0EA", accent: "#0369A1", apply: "#0369A1", maybe: "#B45309", skip: "#5C7186", done: "#047857", sel: "#E6F1FA", code: "#0B1620", codeInk: "#CFDCE8" },
    dark: { bg: "#0C141C", panel: "#132029", ink: "#DCE7F0", mute: "#7F95A8", rule: "#22323F", accent: "#5CB8F0", apply: "#5CB8F0", maybe: "#E0A458", skip: "#7F95A8", done: "#4ADE9A", sel: "#1B2D3A", code: "#070D12", codeInk: "#BFD0DE" },
  },
  forest: {
    name: "Forest",
    light: { bg: "#F3F6F3", panel: "#FFFFFF", ink: "#14201A", mute: "#5E7266", rule: "#D8E2DB", accent: "#15803D", apply: "#15803D", maybe: "#B45309", skip: "#5E7266", done: "#0F766E", sel: "#E8F3EB", code: "#0D1610", codeInk: "#CFDCD3" },
    dark: { bg: "#0E1511", panel: "#152019", ink: "#DEE8E1", mute: "#85998B", rule: "#233229", accent: "#5FD38A", apply: "#5FD38A", maybe: "#E0A458", skip: "#85998B", done: "#5EEAD4", sel: "#1C2B21", code: "#080E0A", codeInk: "#BFD0C5" },
  },
  ember: {
    name: "Ember",
    light: { bg: "#F8F5F2", panel: "#FFFFFF", ink: "#231A15", mute: "#7A6B62", rule: "#E6DDD6", accent: "#C2410C", apply: "#C2410C", maybe: "#A16207", skip: "#7A6B62", done: "#047857", sel: "#FBEEE6", code: "#1A120E", codeInk: "#E4D8D0" },
    dark: { bg: "#17110E", panel: "#211915", ink: "#EEE4DC", mute: "#A08F85", rule: "#352A24", accent: "#F59E6B", apply: "#F59E6B", maybe: "#E0B458", skip: "#A08F85", done: "#4ADE9A", sel: "#2E211B", code: "#0F0A08", codeInk: "#D4C8BF" },
  },
  mono: {
    name: "Mono",
    light: { bg: "#F4F4F4", panel: "#FFFFFF", ink: "#111111", mute: "#666666", rule: "#DADADA", accent: "#111111", apply: "#111111", maybe: "#555555", skip: "#888888", done: "#333333", sel: "#EAEAEA", code: "#111111", codeInk: "#DDDDDD" },
    dark: { bg: "#0F0F0F", panel: "#181818", ink: "#EDEDED", mute: "#9A9A9A", rule: "#2A2A2A", accent: "#EDEDED", apply: "#EDEDED", maybe: "#BBBBBB", skip: "#777777", done: "#CCCCCC", sel: "#242424", code: "#080808", codeInk: "#CFCFCF" },
  },
}

export const DEFAULT_PALETTE = "graphite"
export type Mode = "light" | "dark" | "system"
export const MODES: Mode[] = ["light", "dark", "system"]

const block = (vars: Record<string, string>) => V.map((k) => `--${k}:${vars[k]}`).join(";")

/** CSS: one rule per palette × mode; `system` follows `prefers-color-scheme`. Selected by attributes on `<html>`. */
export function themeCss(): string {
  const rules: string[] = []
  for (const [id, p] of Object.entries(PALETTES)) {
    rules.push(`html[data-palette="${id}"]{${block(p.light)}}`)
    rules.push(`html[data-palette="${id}"][data-mode="dark"]{${block(p.dark)}}`)
    rules.push(`@media (prefers-color-scheme: dark){html[data-palette="${id}"][data-mode="system"]{${block(p.dark)}}}`)
  }
  return rules.join("\n") + `
html{color-scheme:light}html[data-mode="dark"]{color-scheme:dark}@media (prefers-color-scheme: dark){html[data-mode="system"]{color-scheme:dark}}
.theme{display:flex;gap:6px;align-items:center;margin-left:14px;white-space:nowrap}
.theme select{font:inherit;font-size:12px;padding:3px 6px;border:1px solid var(--rule);border-radius:4px;background:var(--panel);color:var(--ink)}
.theme button{font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--rule);border-radius:4px;background:var(--panel);color:var(--ink);cursor:pointer}
.theme button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}`
}

/** The switcher: a palette select and light/dark/system buttons. Goes in the header. */
export function themeSwitcher(): string {
  const opts = Object.entries(PALETTES).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join("")
  const modes = MODES.map((m) => `<button type="button" data-mode-btn="${m}" aria-pressed="false">${m}</button>`).join("")
  return `<div class="theme" role="group" aria-label="Theme"><select id="palette" aria-label="Palette">${opts}</select>${modes}</div>`
}

/**
 * Inline script for `<head>`: applies the stored (or default) theme before first paint so there is no flash,
 * then wires the switcher once the DOM exists. `defaults` come from the profile.
 */
export function themeScript(defaults: { palette?: string; mode?: Mode }): string {
  const palette = PALETTES[defaults.palette ?? ""] ? defaults.palette : DEFAULT_PALETTE
  const mode: Mode = defaults.mode && MODES.includes(defaults.mode) ? defaults.mode : "system"
  return `<script>(function(){
var P=${JSON.stringify(Object.keys(PALETTES))},M=${JSON.stringify(MODES)};
var s={};try{s=JSON.parse(localStorage.getItem("jobsweep:theme")||"{}")}catch(e){}
var pal=P.indexOf(s.palette)>=0?s.palette:${JSON.stringify(palette)},mode=M.indexOf(s.mode)>=0?s.mode:${JSON.stringify(mode)};
var h=document.documentElement;h.setAttribute("data-palette",pal);h.setAttribute("data-mode",mode);
function save(){localStorage.setItem("jobsweep:theme",JSON.stringify({palette:pal,mode:mode}))}
function paint(){var sel=document.getElementById("palette");if(sel)sel.value=pal;document.querySelectorAll("[data-mode-btn]").forEach(function(b){b.setAttribute("aria-pressed",String(b.getAttribute("data-mode-btn")===mode))})}
document.addEventListener("DOMContentLoaded",function(){paint();
var sel=document.getElementById("palette");if(sel)sel.addEventListener("change",function(){pal=sel.value;h.setAttribute("data-palette",pal);save();paint()});
document.querySelectorAll("[data-mode-btn]").forEach(function(b){b.addEventListener("click",function(){mode=b.getAttribute("data-mode-btn");h.setAttribute("data-mode",mode);save();paint()})})});
})();</script>`
}

/** What the profile may set: starting palette and mode; the page's own switcher then takes over (localStorage). */
export interface ThemePrefs {
  palette?: string
  mode?: Mode
}
