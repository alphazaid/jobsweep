import { describe, expect, test } from "bun:test"
import { decodeEntities, htmlToText, levelFromTitle, parseSalary, parseYoe } from "../src/text.ts"

describe("parseSalary", () => {
  test("Greenhouse pay-range block with em dash and USD suffix", () => {
    const text = htmlToText(decodeEntities("&lt;div class=\"pay-range\"&gt;&lt;span&gt;$190,000&lt;/span&gt;&lt;span&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$267,000 USD&lt;/span&gt;&lt;/div&gt;"))
    expect(parseSalary(text)).toMatchObject({ min: 190_000, max: 267_000, kind: "parsed" })
  })

  test("K-suffixed band", () => {
    expect(parseSalary("Salary: $150K – $180K • Offers Equity")).toMatchObject({ min: 150_000, max: 180_000 })
  })

  test("picks the highest of several geo bands", () => {
    const text = "Base salary range: $140,000 - $170,000 (Denver). New York: $170,000 - $210,000 base salary."
    expect(parseSalary(text)).toMatchObject({ min: 170_000, max: 210_000 })
  })

  test("annualizes hourly pay", () => {
    expect(parseSalary("Pay: $60 - $75 per hour")).toMatchObject({ min: 124_800, max: 156_000 })
  })

  test("Amazon-style band with cents and trailing USD", () => {
    expect(parseSalary("USA, NY, New York - 158,100.00 - 213,800.00 USD annually")).toMatchObject({ min: 158_100, max: 213_800 })
  })

  test("ignores year ranges and unrelated numbers", () => {
    expect(parseSalary("Founded in 2015 to 2020, we grew from 10 to 400 people. Apply by 2026.")).toBeNull()
  })

  test("null on missing text", () => {
    expect(parseSalary(null)).toBeNull()
  })
})

describe("parseYoe", () => {
  test("N+ years of experience", () => {
    expect(parseYoe("What you need: 5+ years of experience building software")).toBe(5)
  })
  test("Minimum N years", () => {
    expect(parseYoe("Minimum 3 years of professional software engineering experience")).toBe(3)
  })
  test("range takes the floor", () => {
    expect(parseYoe("2-4 years' experience with Go")).toBe(2)
  })
  test("first requirement wins over later nice-to-have", () => {
    expect(parseYoe("Requirements: 2+ years of backend experience. Nice to have: 10+ years of Kubernetes experience.")).toBe(2)
  })
  test("several requirements in one block: the largest binds (Reddit pattern)", () => {
    const text =
      "Qualifications\nBS degree. 3+ years of industry experience in large-scale distributed systems. 5+ years of hands-on, professional software development experience in Go or Python. Experienced with GraphQL."
    expect(parseYoe(text)).toBe(5)
  })
  test("no requirement", () => {
    expect(parseYoe("We value experience over years in seat.")).toBeNull()
  })
})

describe("levelFromTitle", () => {
  test.each([
    ["Software Engineer Intern", "intern"],
    ["Software Engineer, New Grad", "entry"],
    ["Software Engineer II", "mid"],
    ["Software Engineer", "mid"],
    ["Senior Software Engineer", "senior"],
    ["Staff Engineer, Platform", "staff"],
    ["Principal Engineer", "staff"],
    ["Engineering Lead", "staff"],
    ["Engineering Manager - Platform", "staff"],
  ] as const)("%s → %s", (title, level) => {
    expect(levelFromTitle(title)).toBe(level)
  })
})
