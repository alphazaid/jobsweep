import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db.ts"
import type { Provider, ProviderCtx } from "../src/providers/provider.ts"
import { run } from "../src/run.ts"
import { SWE_TITLE_RE, type Job, type SearchParams } from "../src/types.ts"

const params: SearchParams = {
  queries: ["software engineer"],
  titleRe: SWE_TITLE_RE,
  city: "New York, NY",
  remote: "include",
  minTc: null,
  maxYoe: null,
  levels: null,
  days: 14,
  sources: ["linkedin"],
  perSource: 10,
  hydrate: true,
  linkedinAccepted: true,
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id: `linkedin:${id}`,
    source: "linkedin",
    sourceId: id,
    title: "Software Engineer",
    company: `Co${id}`,
    location: "New York, NY",
    locations: ["New York, NY"],
    workMode: null,
    url: `https://www.linkedin.com/jobs/view/${id}`,
    postedAt: "2026-09-01",
    salary: { min: 200_000, max: 250_000, raw: "", kind: "parsed" },
    yoeMin: 2,
    level: "mid",
    description: null,
    fit: null,
    ...over,
  }
}

/**
 * A LinkedIn stand-in: `search` returns whatever the test says this call and retires `closed`;
 * `revalidate` confirms everything except `closed` (retiring those), or is absent when `noRevalidate`.
 */
function fake(returns: Job[], closed: string[] = [], noRevalidate = false): Provider {
  const p: Provider = {
    source: "linkedin",
    async search(_p, ctx) {
      for (const id of closed) ctx.retire(`linkedin:${id}`)
      return returns
    },
  }
  if (!noRevalidate) {
    p.revalidate = async (ids, ctx) => {
      const open = new Set<string>()
      for (const id of ids) {
        if (closed.includes(id)) ctx.retire(`linkedin:${id}`)
        else open.add(id)
      }
      return open
    }
  }
  return p
}

let dir: string
let store: Store
let clock: number
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobsearch-"))
  clock = Date.parse("2026-09-02T12:00:00Z")
  store = new Store(join(dir, "t.db"), () => clock)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const ctxWith = (p: Provider): ProviderCtx => ({ companies: [], cache: store, retire: (id) => store.remove(id), log: () => {}, providers: { linkedin: p } })
const profile = { skills: [], exclude: [] }

describe("run carry-forward", () => {
  test("a posting the sampled source stops returning is carried, labelled, and not re-recorded", async () => {
    const r1 = await run([params], profile, ctxWith(fake([job("1"), job("2")])), store)
    expect(Object.keys(r1.newIds).sort()).toEqual(["linkedin:1", "linkedin:2"])
    expect(r1.carriedIds).toEqual({})

    const r2 = await run([params], profile, ctxWith(fake([job("2")])), store)
    expect(r2.jobs.map((j) => j.id).sort()).toEqual(["linkedin:1", "linkedin:2"])
    expect(r2.carriedIds).toEqual({ "linkedin:1": true })
    expect(r2.newIds).toEqual({})
  })

  test("carried postings are re-filtered by today's params", async () => {
    await run([params], profile, ctxWith(fake([job("1", { yoeMin: 5 }), job("2")])), store)
    const r2 = await run([{ ...params, maxYoe: 3 }], profile, ctxWith(fake([])), store)
    expect(r2.jobs.map((j) => j.id)).toEqual(["linkedin:2"])
  })

  test("a posting the source reports closed is retired and never carried", async () => {
    await run([params], profile, ctxWith(fake([job("1"), job("2")])), store)
    const r2 = await run([params], profile, ctxWith(fake([job("2")], ["1"])), store)
    expect(r2.jobs.map((j) => j.id)).toEqual(["linkedin:2"])
    expect(store.job("linkedin:1")).toBeNull()
  })

  test("carry does not refresh last_seen: a posting ages out at the window (fake clock)", async () => {
    await run([params], profile, ctxWith(fake([job("1")])), store)
    const liveAt = clock
    clock += 2 * 86_400_000
    // Two carry-only runs must not touch last_seen.
    await run([params], profile, ctxWith(fake([])), store)
    await run([params], profile, ctxWith(fake([])), store)
    expect(store.recent("linkedin:", liveAt + 1)).toEqual([])
    expect(store.recent("linkedin:", liveAt).map((j) => j.id)).toEqual(["linkedin:1"])
    // Past the 14-day window since the last live observation → gone.
    clock = liveAt + 15 * 86_400_000
    const r = await run([{ ...params, days: null }], profile, ctxWith(fake([])), store)
    expect(r.jobs).toEqual([])
  })

  test("a carried posting that revalidation finds closed is dropped and retired", async () => {
    await run([params], profile, ctxWith(fake([job("1"), job("2")])), store)
    // Source returns neither; revalidate says 1 is closed.
    const r2 = await run([params], profile, ctxWith(fake([], ["1"])), store)
    expect(r2.jobs.map((j) => j.id)).toEqual(["linkedin:2"])
    expect(r2.carriedIds).toEqual({ "linkedin:2": true })
    expect(store.job("linkedin:1")).toBeNull()
  })

  test("carried postings honor the posting-date window and require a known date", async () => {
    const old = job("old", { postedAt: "2026-08-01" }) // 32 days before the clock
    const undated = job("undated", { postedAt: null })
    await run([{ ...params, days: null }], profile, ctxWith(fake([old, undated, job("fresh")])), store)
    const r2 = await run([{ ...params, days: 14 }], profile, ctxWith(fake([])), store)
    expect(r2.jobs.map((j) => j.id)).toEqual(["linkedin:fresh"])
  })

  test("a provider without revalidate carries on last observation alone", async () => {
    await run([params], profile, ctxWith(fake([job("1")], [], true)), store)
    const r2 = await run([params], profile, ctxWith(fake([], [], true)), store)
    expect(r2.carriedIds).toEqual({ "linkedin:1": true })
  })

  test("listing sources (boards) are never carried", async () => {
    const gh: Provider = { source: "greenhouse", async search() { return [job("g", { id: "greenhouse:acme:1", source: "greenhouse", sourceId: "acme:1" })] } }
    const p = { ...params, sources: ["greenhouse" as const] }
    await run([p], profile, { companies: [], cache: store, retire: () => {}, log: () => {}, providers: { greenhouse: gh } }, store)
    const r2 = await run([p], profile, { companies: [], cache: store, retire: () => {}, log: () => {}, providers: { greenhouse: { source: "greenhouse", async search() { return [] } } } }, store)
    expect(r2.jobs).toEqual([])
  })
})
