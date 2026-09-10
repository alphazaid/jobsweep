import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { parseProfile } from "../src/profile.ts"
import { PALETTES, themeScript } from "../src/theme.ts"

describe("theme", () => {
  test("every palette defines every variable for both modes", () => {
    const keys = Object.keys(PALETTES.graphite!.light)
    for (const [id, p] of Object.entries(PALETTES)) {
      expect(Object.keys(p.light).sort(), id).toEqual([...keys].sort())
      expect(Object.keys(p.dark).sort(), id).toEqual([...keys].sort())
      for (const v of Object.values({ ...p.light, ...p.dark })) expect(v, id).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  test("stored theme overrides profile before paint; switching persists for the next page", () => {
    let stored = JSON.stringify({ palette: "forest", mode: "dark" })
    const load = () => {
      const attributes: Record<string, string> = {}
      const listeners: Record<string, () => void> = {}
      const buttons = ["light", "dark", "system"].map((mode) => ({
        pressed: "false",
        click: () => {},
        getAttribute: () => mode,
        setAttribute(_name: string, value: string) { this.pressed = value },
        addEventListener(_name: string, fn: () => void) { this.click = fn },
      }))
      const select = { value: "", change: () => {}, addEventListener(_name: string, fn: () => void) { this.change = fn } }
      const document = {
        documentElement: { setAttribute(name: string, value: string) { attributes[name] = value } },
        addEventListener(name: string, fn: () => void) { listeners[name] = fn },
        getElementById: () => select,
        querySelectorAll: () => buttons,
      }
      const localStorage = { getItem: () => stored, setItem(_key: string, value: string) { stored = value } }
      runInNewContext(themeScript({ palette: "ember", mode: "light" }).replace(/^<script>|<\/script>$/g, ""), { document, localStorage })
      return { attributes, listeners, buttons, select }
    }
    const page = load()
    expect(page.attributes).toEqual({ "data-palette": "forest", "data-mode": "dark" })
    page.listeners.DOMContentLoaded!()
    expect(page.select.value).toBe("forest")
    expect(page.buttons.map((b) => b.pressed)).toEqual(["false", "true", "false"])
    for (const palette of Object.keys(PALETTES)) {
      page.select.value = palette
      page.select.change()
      for (const [index, mode] of ["light", "dark", "system"].entries()) {
        page.buttons[index]!.click()
        expect(load().attributes).toEqual({ "data-palette": palette, "data-mode": mode })
      }
    }
    stored = "{broken"
    expect(load().attributes).toEqual({ "data-palette": "ember", "data-mode": "light" })
    stored = JSON.stringify({ palette: "missing", mode: "missing" })
    expect(load().attributes).toEqual({ "data-palette": "ember", "data-mode": "light" })
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
