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
})
