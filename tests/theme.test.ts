import { describe, expect, test } from "bun:test"
import { renderDashboard } from "../src/dashboard.ts"
import { parseProfile } from "../src/profile.ts"
import { DEFAULT_PALETTE, MODES, PALETTES, themeCss, themeScript, themeSwitcher } from "../src/theme.ts"
import { renderUi } from "../src/ui.ts"

describe("theme", () => {
  test("every palette defines every variable for both modes, and the CSS covers palette × mode × system", () => {
    const keys = Object.keys(PALETTES.graphite!.light)
    for (const [id, p] of Object.entries(PALETTES)) {
      expect(Object.keys(p.light).sort(), id).toEqual([...keys].sort())
      expect(Object.keys(p.dark).sort(), id).toEqual([...keys].sort())
      for (const v of Object.values({ ...p.light, ...p.dark })) expect(v, id).toMatch(/^#[0-9A-F]{6}$/)
    }
    const css = themeCss()
    for (const id of Object.keys(PALETTES)) {
      expect(css).toContain(`html[data-palette="${id}"]{`)
      expect(css).toContain(`html[data-palette="${id}"][data-mode="dark"]{`)
      expect(css).toContain(`@media (prefers-color-scheme: dark){html[data-palette="${id}"][data-mode="system"]{`)
    }
    expect(css).not.toContain("gradient")
    expect(css).not.toContain("box-shadow")
  })

  test("switcher lists every palette and mode; script applies defaults before paint and prefers stored choice", () => {
    const sw = themeSwitcher()
    for (const [id, p] of Object.entries(PALETTES)) expect(sw).toContain(`<option value="${id}">${p.name}</option>`)
    for (const m of MODES) expect(sw).toContain(`data-mode-btn="${m}"`)
    const script = themeScript({ palette: "ocean", mode: "dark" })
    expect(script).toContain('"ocean"')
    expect(script).toContain('"dark"')
    expect(script).toContain('localStorage.getItem("jobsweep:theme")')
    // Unknown profile values fall back rather than breaking the page.
    const fallback = themeScript({ palette: "neon", mode: "disco" as never })
    expect(fallback).toContain(`"${DEFAULT_PALETTE}"`)
    expect(fallback).toContain('"system"')
  })

  test("both pages emit the theme CSS, the pre-paint script, and the switcher; no hardcoded page colors remain", () => {
    const dash = renderDashboard({ date: "2026-09-03", cities: ["A"], jobs: [], newIds: new Set(), carriedIds: new Set(), decisions: {}, runs: [], theme: { palette: "ember" } })
    const ui = renderUi([], { title: "t", subtitle: "s", date: "2026-09-03", floor: null, skills: [], isLocal: () => true, storageKey: "k", theme: { mode: "dark" } })
    for (const html of [dash, ui]) {
      expect(html).toContain('html[data-palette="graphite"]')
      expect(html).toContain('localStorage.getItem("jobsweep:theme")')
      expect(html).toContain('id="palette"')
      // Page styles (after the theme block) reference variables, never literal colors.
      const pageCss = html.slice(html.indexOf(".theme button[aria-pressed"))
      expect(pageCss.slice(0, pageCss.indexOf("</style>"))).not.toMatch(/#[0-9A-Fa-f]{3,6}\b/)
    }
    expect(dash).toContain('"ember"')
    expect(ui).toContain('"dark"')
  })

  test("profile.theme is validated", () => {
    const base = { cities: ["A"] }
    expect(parseProfile({ ...base, theme: { palette: "ocean", mode: "dark" } }).theme).toEqual({ palette: "ocean", mode: "dark" })
    expect(parseProfile({ ...base }).theme).toBeNull()
    expect(() => parseProfile({ ...base, theme: { palette: "neon" } })).toThrow("theme.palette must be one of")
    expect(() => parseProfile({ ...base, theme: { mode: "disco" } })).toThrow("theme.mode must be one of")
    expect(() => parseProfile({ ...base, theme: "dark" })).toThrow("theme must be an object")
  })
})
