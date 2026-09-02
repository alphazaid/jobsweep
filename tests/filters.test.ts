import { describe, expect, test } from "bun:test"
import { applyFilters, dedupe, matchedLocation, meetsExperience, meetsTc } from "../src/filters.ts"
import { SWE_TITLE_RE, type Job, type SearchParams } from "../src/types.ts"

const base: SearchParams = {
  queries: ["software engineer"],
  titleRe: SWE_TITLE_RE,
  city: "New York, NY",
  remote: "include",
  minTc: null,
  maxYoe: null,
  levels: null,
  days: null,
  sources: [],
  perSource: 0,
  hydrate: false,
  linkedinAccepted: false,
}

function job(over: Partial<Job>): Job {
  return {
    id: over.id ?? `t:${Math.random()}`,
    source: "greenhouse",
    sourceId: "x",
    title: "Software Engineer",
    company: "Acme",
    location: "New York, NY",
    locations: [],
    workMode: null,
    url: "https://example.com",
    postedAt: null,
    salary: null,
    yoeMin: null,
    level: "mid",
    fit: null,
    description: null,
    ...over,
  }
}

describe("matchedLocation", () => {
  test("metro alias hit", () => {
    expect(matchedLocation(job({ location: "Brooklyn, NY" }), base)).toBe("Brooklyn, NY")
  })
  test("secondary location counts and is the one reported", () => {
    const j = job({ location: "San Francisco, CA", locations: ["San Francisco, CA", "New York, NY"] })
    expect(matchedLocation(j, base)).toBe("New York, NY")
  })
  test("US remote is included by default", () => {
    expect(matchedLocation(job({ location: "Remote - United States" }), base)).toBe("Remote - United States")
  })
  test("foreign remote is not", () => {
    expect(matchedLocation(job({ location: "Remote (Canada)" }), base)).toBeNull()
  })
  test("bare 'United States' suffix is not remote", () => {
    expect(matchedLocation(job({ location: "San Mateo, CA, United States" }), base)).toBeNull()
  })
  test("remote=exclude drops remote and keeps on-site city", () => {
    const p = { ...base, remote: "exclude" as const }
    expect(matchedLocation(job({ location: "Remote - US" }), p)).toBeNull()
    expect(matchedLocation(job({ location: "New York, NY", workMode: "remote" }), p)).toBeNull()
    expect(matchedLocation(job({ location: "New York, NY" }), p)).toBe("New York, NY")
  })
  test("remote=only drops city-only postings", () => {
    const p = { ...base, remote: "only" as const }
    expect(matchedLocation(job({ location: "New York, NY" }), p)).toBeNull()
    expect(matchedLocation(job({ location: "Remote" }), p)).toBe("Remote")
  })
})

describe("meetsTc", () => {
  test("ceiling clears the floor", () => {
    expect(meetsTc(job({ salary: { min: 150_000, max: 200_000, raw: "", kind: "parsed" } }), 180_000)).toBe(true)
  })
  test("ceiling below the floor fails", () => {
    expect(meetsTc(job({ salary: { min: 120_000, max: 170_000, raw: "", kind: "parsed" } }), 180_000)).toBe(false)
  })
  test("unknown comp passes", () => {
    expect(meetsTc(job({ salary: null }), 180_000)).toBe(true)
  })
})

describe("meetsExperience", () => {
  test("stated YOE above max fails", () => {
    expect(meetsExperience(job({ yoeMin: 5 }), { ...base, maxYoe: 3 })).toBe(false)
  })
  test("stated YOE at max passes even for a senior title", () => {
    expect(meetsExperience(job({ yoeMin: 3, level: "senior" }), { ...base, maxYoe: 3 })).toBe(true)
  })
  test("unstated YOE falls back to the title band", () => {
    expect(meetsExperience(job({ level: "senior" }), { ...base, maxYoe: 3 })).toBe(false)
    expect(meetsExperience(job({ level: "mid" }), { ...base, maxYoe: 3 })).toBe(true)
  })
  test("--level restricts the band regardless of YOE", () => {
    expect(meetsExperience(job({ level: "senior", yoeMin: 1 }), { ...base, levels: ["entry", "mid"] })).toBe(false)
  })
})

describe("dedupe", () => {
  test("keeps the copy with structured comp over the aggregator copy", () => {
    const li = job({ id: "linkedin:1", source: "linkedin", company: "Ramp", title: "Software Engineer", location: "New York, NY" })
    const as = job({ id: "ashby:1", source: "ashby", company: "Ramp, Inc.", title: "Software Engineer", location: "New York, NY", salary: { min: 1, max: 2, raw: "", kind: "structured" } })
    const out = dedupe([li, as])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe("ashby:1")
  })
  test("different cities are different postings", () => {
    expect(dedupe([job({ id: "a", location: "New York, NY" }), job({ id: "b", location: "Dallas, TX" })])).toHaveLength(2)
  })
  test("same posting across metro spellings collapses", () => {
    const a = job({ id: "linkedin:1", source: "linkedin", company: "Pave", title: "Software Engineer, Developer Platform", location: "New York City Metropolitan Area" })
    const b = job({ id: "freehire:1", source: "freehire", company: "Pave", title: "Software Engineer, Developer Platform", location: "San Francisco, CA & New York, NY" })
    expect(dedupe([a, b])).toHaveLength(1)
  })
  test("company board copy suppresses an aggregator copy with a different location (Stripe/Toronto case)", () => {
    const gh = job({ id: "greenhouse:stripe:1", source: "greenhouse", company: "Stripe", title: "Software Engineer, Metronome Infrastructure", location: "Toronto, Vancouver, Canada-Remote" })
    const fh = job({ id: "freehire:1", source: "freehire", company: "Stripe", title: "Software Engineer, Metronome Infrastructure", location: "New York City" })
    const out = dedupe([fh, gh])
    expect(out.map((j) => j.id)).toEqual(["greenhouse:stripe:1"])
  })
})

describe("applyFilters", () => {
  test("counts drops by reason and rewrites location to the match", () => {
    const p = { ...base, minTc: 180_000, maxYoe: 3 }
    const r = applyFilters(
      [
        job({ location: "Austin, TX" }),
        job({ salary: { min: 100_000, max: 150_000, raw: "", kind: "parsed" } }),
        job({ yoeMin: 7 }),
        job({ location: "Seattle, WA", locations: ["Seattle, WA", "Manhattan, NY"] }),
      ],
      p,
    )
    expect(r.dropped).toEqual({ city: 1, tc: 1, experience: 1 })
    expect(r.kept).toHaveLength(1)
    expect(r.kept[0]!.location).toBe("Manhattan, NY")
  })
})
