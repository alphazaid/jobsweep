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
    ai: null,
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
  test("a Canada-remote posting never matches a US city search (Stripe Metronome case)", () => {
    const j = job({ location: "Toronto, Vancouver, Canada-Remote", locations: ["Toronto, Vancouver, Canada-Remote"], workMode: "remote" })
    expect(matchedLocation(j, base)).toBeNull()
    expect(matchedLocation(j, { ...base, remote: "only" })).toBeNull()
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

  test("a remote flag does not make a foreign location US-eligible", () => {
    for (const [id, location] of [
      ["hong-kong", "Hong Kong"],
      ["foreign-city", "Ulaanbaatar"],
      ["foreign-remote", "Remote - Mongolia"],
    ]) {
      expect(matchedLocation(job({ id: `location:${id}`, location, workMode: "remote" }), base)).toBeNull()
    }
  })

  test("candidate residency requirements override remote and NYC metadata", () => {
    const description = "This role is remote, but candidates must be based in Hong Kong. We are hiring specifically for this market, so applicants should already be based in Hong Kong."
    for (const [id, location] of [["remote", "Remote - United States"], ["city", "New York, NY"]]) {
      const j = job({ id: `residency:${id}`, location, locations: [location!], workMode: "remote", description })
      expect(matchedLocation(j, base)).toBeNull()
      expect(matchedLocation(j, { ...base, remote: "only" })).toBeNull()
    }
  })

  test("state hiring exclusions override US remote eligibility and salary geography", () => {
    const exclusions = [
      "This role is remote in the USA, but candidates are not eligible to be hired in CA, NY, WA, PA, CT.",
      "This role is remote in the United States. We cannot hire candidates residing in New York.",
    ]
    for (const [index, restriction] of exclusions.entries()) {
      const j = job({
        id: `state-exclusion:${index}`,
        location: "Remote - United States",
        workMode: "remote",
        description: `${restriction}\nCompensation for New York City applicants: $180,000 - $220,000.`,
      })
      expect(matchedLocation(j, base)).toBeNull()
    }
  })

  test("required out-of-metro attendance overrides a remote label", () => {
    const postings: Partial<Job>[] = [
      {
        id: "attendance:clera",
        location: "Los Angeles, CA",
        description: "On-site in *Los Angeles, CA, United States*.",
      },
      {
        id: "attendance:medical-mutual",
        location: "Cleveland, OH",
        description: "This is a hybrid‑remote role based out of the Brooklyn, OH office, with the expectation to work onsite on designated in‑office days each week.",
      },
      {
        id: "attendance:mislabelled-nyc",
        location: "New York, NY",
        description: "This role requires working onsite at our San Francisco, CA office three days per week.",
      },
    ]
    for (const posting of postings) {
      const j = job({ ...posting, workMode: "remote" })
      expect(matchedLocation(j, base)).toBeNull()
      expect(matchedLocation(j, { ...base, remote: "only" })).toBeNull()
    }
  })

  test("city matches respect word boundaries and conflicting jurisdictions", () => {
    expect(matchedLocation(job({ id: "boundary:brooklyn-oh", location: "Brooklyn, OH" }), base)).toBeNull()
    expect(matchedLocation(job({ id: "boundary:austinville", location: "Austinville, VA" }), { ...base, city: "Austin, TX" })).toBeNull()
    expect(matchedLocation(job({ id: "boundary:london-ontario", location: "London, Ontario, Canada" }), { ...base, city: "London, UK" })).toBeNull()
  })

  test("non-US local searches retain their own city", () => {
    expect(matchedLocation(job({ id: "local:london", location: "London, UK" }), { ...base, city: "London, UK" })).toBe("London, UK")
  })

  test("NYC metro and NYC alternatives remain available without remote eligibility", () => {
    for (const [id, location] of [["jersey-city", "Jersey City, NJ"], ["hoboken", "Hoboken, NJ"]]) {
      expect(matchedLocation(job({ id: `metro:${id}`, location }), { ...base, remote: "exclude" })).toBe(location!)
    }
    const j = job({
      id: "metro:onsite-alternatives",
      location: "San Francisco, CA",
      locations: ["San Francisco, CA", "New York, NY"],
      workMode: "onsite",
      description: "This role is onsite in either San Francisco, CA or New York, NY.",
    })
    expect(matchedLocation(j, { ...base, remote: "exclude" })).toBe("New York, NY")
  })

  test("US, worldwide, and unrestricted remote remain eligible in remote-only searches", () => {
    for (const [id, location] of [
      ["us", "Remote - United States"],
      ["worldwide", "Remote - Worldwide"],
      ["global-label", "Remote, Global"],
      ["dotted-us", "Remote U.S."],
      ["unrestricted", "Remote"],
    ]) {
      const j = job({ id: `eligible:${id}`, location, workMode: "remote" })
      expect(matchedLocation(j, base)).toBe(location!)
      expect(matchedLocation(j, { ...base, remote: "only" })).toBe(location!)
      expect(matchedLocation(j, { ...base, remote: "exclude" })).toBeNull()
    }
  })

  test("a foreign remote alternative does not veto an eligible US option", () => {
    const j = job({
      id: "eligible:multi-region",
      location: "Remote - Canada",
      locations: ["Remote - Canada", "Remote - United States"],
      workMode: "remote",
      description: "Candidates must be based in the United States or Canada.",
    })
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe("Remote - United States")
    const combined = job({
      id: "eligible:combined-regions",
      location: "United States / Canada",
      workMode: "remote",
      description: "Candidates must be based in the United States or Canada. Occasional travel to field sites may be required.",
    })
    expect(matchedLocation(combined, { ...base, remote: "only" })).toBe("United States / Canada")
  })

  test("headquarters, salary geography, and optional travel are not residence requirements", () => {
    const j = job({
      id: "eligible:incidental-geography",
      location: "Remote - United States",
      workMode: "remote",
      description: "We are headquartered in London, UK. This role is fully remote anywhere in the United States. Optional travel to our Hong Kong office is available. California compensation range: $180,000 - $220,000.",
    })
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe("Remote - United States")
  })

  test("negated outside-metro office requirements do not exclude US remote roles", () => {
    const j = job({
      id: "eligible:negated-attendance",
      location: "Remote - United States",
      workMode: "remote",
      description: "You are not required to work onsite at our San Francisco office. Candidates can work remotely from anywhere in the United States.",
    })
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe("Remote - United States")
  })

  test("required NYC hybrid attendance remains local rather than fully remote", () => {
    const j = job({
      id: "metro:hybrid",
      location: "New York, NY",
      workMode: "hybrid",
      description: "We have a hybrid work culture that combines regular in-person collaboration at our New York City office (3+ days per week) with flexibility to work remotely.",
    })
    expect(matchedLocation(j, base)).toBe("New York, NY")
    expect(matchedLocation(j, { ...base, remote: "exclude" })).toBe("New York, NY")
    expect(matchedLocation(j, { ...base, remote: "only" })).toBeNull()
  })

  test("onsite interviews do not impose a permanent work location", () => {
    const j = job({
      id: "eligible:interview",
      location: "New York",
      locations: ["San Francisco", "New York"],
      workMode: "onsite",
      description: "We work in person in San Francisco and New York. After the technicals, we'll schedule an onsite in our office, where you'll meet the team.",
    })
    expect(matchedLocation(j, { ...base, remote: "exclude" })).toBe("New York")
  })

  test("an unnamed mandatory office falls back to the local posting location", () => {
    const j = job({
      id: "eligible:unnamed-office",
      location: "New York, NY",
      workMode: "remote",
      description: "Where we have offices, employees are expected to be in office for 4 days per week.",
    })
    expect(matchedLocation(j, base)).toBe("New York, NY")
    expect(matchedLocation(j, { ...base, remote: "only" })).toBeNull()
  })

  test("temporary onboarding and occasional travel preserve remote eligibility", () => {
    const j = job({
      id: "eligible:temporary-attendance",
      location: "Santa Clara, CA or Remote",
      workMode: "remote",
      description: "Remote employees must travel to headquarters in Santa Clara twice a quarter. For the first two weeks of onboarding, employees are required to be in person at headquarters in Santa Clara, CA.",
    })
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe("Santa Clara, CA or Remote")
  })

  test("the pronoun us is not evidence of US eligibility", () => {
    const j = job({
      id: "geography:pronoun",
      location: "Malaysia",
      workMode: "remote",
      description: "This role is remote and you will work with us from Malaysia.",
    })
    expect(matchedLocation(j, base)).toBeNull()
    expect(matchedLocation(job({
      ...j,
      location: "Remote - United States",
      description: "Candidates must be based in Hong Kong and help us build our product.",
    }), base)).toBeNull()
  })

  test("company-wide onsite transitions do not override a remote role exception", () => {
    const j = job({
      id: "eligible:company-policy",
      location: "100 New Millennium Way, Bldg 1, Durham NC",
      workMode: "remote",
      description: "We are transitioning to full-time onsite work. Currently, some roles and locations require 100% onsite presence, while others require less. This transition does not apply to fully remote roles.",
    })
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe(j.location)
  })

  test("description-only remote eligibility reports Remote rather than foreign headquarters", () => {
    const j = job({
      id: "eligible:description-only",
      location: "London",
      workMode: "remote",
      description: "This role is fully remote anywhere in the United States.",
    })
    expect(matchedLocation(j, base)).toBe("Remote")
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe("Remote")
    expect(matchedLocation(j, { ...base, remote: "exclude" })).toBeNull()
  })

  test("regional remote labels require local or explicit broader eligibility", () => {
    const j = job({
      id: "geography:regional-remote",
      location: "Remote – Washington, DC",
      workMode: "remote",
    })
    expect(matchedLocation(j, base)).toBeNull()
    expect(matchedLocation(job({ ...j, location: "Remote – NY" }), base)).toBe("Remote – NY")
    expect(matchedLocation(job({
      ...j,
      location: "Remote - Located in CA, CO, NY, TX",
    }), base)).toBe("Remote - Located in CA, CO, NY, TX")
    expect(matchedLocation(job({
      ...j,
      description: "This role is fully remote anywhere in the United States.",
    }), base)).toBe("Remote")
  })

  test("office attendance policy explicitly exempts remote roles", () => {
    const j = job({
      id: "eligible:remote-office-exception",
      location: "Remote - United States",
      workMode: "remote",
      description: "Must work from an office 4 days/week (except for remote roles). Where we have offices, employees are expected to be in office for 4 days per week.",
    })
    expect(matchedLocation(j, { ...base, remote: "only" })).toBe(j.location)
    expect(matchedLocation(job({
      ...j,
      description: `${j.description} This role requires working onsite at our Los Angeles office.`,
    }), base)).toBeNull()
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
