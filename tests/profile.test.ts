import { describe, expect, test } from "bun:test"
import { parseProfile } from "../src/profile.ts"
import { DEFAULT_QUERIES } from "../src/types.ts"

describe("parseProfile", () => {
  test("query (single) is honored as one query", () => {
    expect(parseProfile({ cities: ["New York, NY"], query: "software engineer" }).queries).toEqual(["software engineer"])
  })
  test("queries (array) wins; no queries falls back to defaults", () => {
    expect(parseProfile({ cities: ["x"], queries: ["a", "b"] }).queries).toEqual(["a", "b"])
    expect(parseProfile({ cities: ["x"] }).queries).toEqual(DEFAULT_QUERIES)
  })
  test("query and queries together is an error", () => {
    expect(() => parseProfile({ cities: ["x"], query: "a", queries: ["b"] })).toThrow(/not both/)
  })
  test("unknown keys are rejected instead of silently defaulting", () => {
    expect(() => parseProfile({ cities: ["x"], minTC: "200k" })).toThrow(/unknown key "minTC"/)
  })
  test("minTc accepts 200k and 200000", () => {
    expect(parseProfile({ cities: ["x"], minTc: "200k" }).minTc).toBe(200_000)
    expect(parseProfile({ cities: ["x"], minTc: 200000 }).minTc).toBe(200_000)
  })
  test("titlePattern overrides the default gate", () => {
    const p = parseProfile({ cities: ["x"], titlePattern: "^Backend" })
    expect(p.titleRe.test("Backend Engineer")).toBe(true)
    expect(p.titleRe.test("Software Engineer")).toBe(false)
  })
  test("a minimal profile never defaults to LinkedIn, and to Adzuna only with both keys in the environment", () => {
    const saved = { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY }
    try {
      delete process.env.ADZUNA_APP_ID
      delete process.env.ADZUNA_APP_KEY
      expect(parseProfile({ cities: ["x"] }).sources).toEqual(["greenhouse", "lever", "ashby", "freehire"])
      process.env.ADZUNA_APP_ID = "id"
      expect(parseProfile({ cities: ["x"] }).sources).not.toContain("adzuna")
      process.env.ADZUNA_APP_KEY = "key"
      expect(parseProfile({ cities: ["x"] }).sources).toEqual(["greenhouse", "lever", "ashby", "adzuna", "freehire"])
    } finally {
      if (saved.id === undefined) delete process.env.ADZUNA_APP_ID
      else process.env.ADZUNA_APP_ID = saved.id
      if (saved.key === undefined) delete process.env.ADZUNA_APP_KEY
      else process.env.ADZUNA_APP_KEY = saved.key
    }
  })
})
