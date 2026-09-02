import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { linkedin } from "../src/providers/linkedin.ts"
import type { FeedCache, ProviderCtx } from "../src/providers/provider.ts"
import { SWE_TITLE_RE, type SearchParams } from "../src/types.ts"

const card = (id: string, title: string) => `
<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
  <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/${id}?x=1"></a>
  <h3 class="base-search-card__title">${title}</h3>
  <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/acme">Acme</a></h4>
  <span class="job-search-card__location">New York, NY</span>
  <time class="job-search-card__listdate" datetime="2026-09-01">1 day ago</time>
</div></li>`

const detail = (salary: string) => `
<div class="top-card-layout"><h1 class="top-card-layout__title">Software Engineer</h1></div>
<div class="compensation__salary">${salary}</div>
<div class="show-more-less-html__markup"><p>We need 2+ years of backend experience with Go.</p></div>
<h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text">Mid-Senior level</span>`

class MemCache implements FeedCache {
  store: Record<string, { body: string; at: number }> = {}
  get(key: string, maxAgeMs: number): string | null {
    const r = this.store[key]
    return r && Date.now() - r.at <= maxAgeMs ? r.body : null
  }
  set(key: string, body: string): void {
    this.store[key] = { body, at: Date.now() }
  }
}

const params: SearchParams = {
  queries: ["software engineer"],
  titleRe: SWE_TITLE_RE,
  city: "New York, NY",
  remote: "include",
  minTc: null,
  maxYoe: null,
  levels: null,
  days: null,
  sources: ["linkedin"],
  perSource: 10,
  hydrate: true,
  linkedinAccepted: true,
}
let detailFetches: string[]
let failIds: Record<string, true>
let goneIds: Record<string, true>
const realFetch = globalThis.fetch

beforeEach(() => {
  detailFetches = []
  failIds = {}
  goneIds = {}
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes("/seeMoreJobPostings/search")) {
      return new Response(card("111", "Software Engineer, Backend") + card("222", "Sales Engineer"), { status: 200 })
    }
    const id = /jobPosting\/(\d+)/.exec(url)?.[1]
    if (id) {
      detailFetches.push(id)
      // 403 is not retried by getText (429/5xx are, with seconds of backoff); it still throws, which is the path under test.
      if (failIds[id]) return new Response("", { status: 403, statusText: "Forbidden" })
      if (goneIds[id]) return new Response("", { status: 404 })
      return new Response(detail("$180,000 - $220,000"), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

let retired: string[]
function ctx(cache: FeedCache): ProviderCtx {
  retired = []
  return { companies: [], cache, retire: (id) => retired.push(id), log: () => {} }
}

describe("linkedin.search", () => {
  test("refuses to run unless the user accepted the LinkedIn notice", async () => {
    await expect(linkedin.search({ ...params, linkedinAccepted: false }, ctx(new MemCache()))).rejects.toThrow(/LinkedIn connector is off/)
    expect(detailFetches).toEqual([])
  })

  test("gates on title before fetching detail, parses comp/YOE, and caches the parsed detail", async () => {
    const cache = new MemCache()
    const jobs = await linkedin.search(params, ctx(cache))
    expect(detailFetches).toEqual(["111"])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      id: "linkedin:111",
      title: "Software Engineer, Backend",
      company: "Acme",
      location: "New York, NY",
      postedAt: "2026-09-01",
      salary: { min: 180_000, max: 220_000, kind: "parsed" },
      yoeMin: 2,
    })
    expect(cache.get("linkedin:detail:111", 60_000)).not.toBeNull()
  })

  test("second run is a cache hit with identical job fields", async () => {
    const cache = new MemCache()
    const first = await linkedin.search(params, ctx(cache))
    const second = await linkedin.search(params, ctx(cache))
    expect(detailFetches).toEqual(["111"])
    expect(second).toEqual(first)
  })

  test("a card the caller's filters would drop is still served from cache on the next run", async () => {
    // Cache is provider-level (before comp/YOE filters), so changing params later must not refetch.
    const cache = new MemCache()
    await linkedin.search({ ...params, minTc: 300_000 }, ctx(cache))
    const again = await linkedin.search({ ...params, minTc: null }, ctx(cache))
    expect(detailFetches).toEqual(["111"])
    expect(again[0]?.salary).toMatchObject({ min: 180_000, max: 220_000 })
  })

  test("a failed detail fetch is not cached and is retried next run", async () => {
    const cache = new MemCache()
    failIds["111"] = true
    const first = await linkedin.search(params, ctx(cache))
    expect(first[0]?.salary).toBeNull()
    expect(cache.get("linkedin:detail:111", 60_000)).toBeNull()
    failIds = {}
    const second = await linkedin.search(params, ctx(cache))
    expect(detailFetches.filter((id) => id === "111").length).toBeGreaterThanOrEqual(2)
    expect(second[0]?.salary).toMatchObject({ min: 180_000, max: 220_000 })
  })

  test("a removed posting (404) is cached as gone, retired from the store, and never refetched", async () => {
    const cache = new MemCache()
    goneIds["111"] = true
    const first = await linkedin.search(params, ctx(cache))
    expect(first).toEqual([])
    expect(retired).toEqual(["linkedin:111"])
    goneIds = {}
    const second = await linkedin.search(params, ctx(cache))
    expect(detailFetches).toEqual(["111"])
    expect(second).toEqual([])
    // The cached gone-detail retires again, so a stale store row can't survive a cache hit either.
    expect(retired).toEqual(["linkedin:111"])
  })

  test("--no-hydrate returns cards without touching detail pages", async () => {
    const jobs = await linkedin.search({ ...params, hydrate: false }, ctx(new MemCache()))
    expect(detailFetches).toEqual([])
    expect(jobs.map((j) => j.id)).toEqual(["linkedin:111"])
  })
})
