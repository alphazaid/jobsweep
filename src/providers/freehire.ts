import { getJson } from "../http.ts"
import { htmlToText, levelFromTitle, parseSalary, parseYoe, workModeFrom } from "../text.ts"
import type { Job, Level, Salary, SearchParams } from "../types.ts"
import { unionById, type Provider, type ProviderCtx } from "./provider.ts"

const BASE = (process.env.FREEHIRE_API_URL ?? "https://freehire.me").replace(/\/+$/, "")
/** freehire's maximum page size. */
const PAGE_SIZE = 100

interface FhJob {
  public_slug: string
  url: string
  title: string
  company: string
  location: string
  description: string
  work_mode?: string
  cities: string[]
  countries: string[]
  posted_at: string | null
  created_at: string | null
  enrichment: { seniority?: string; salary_min?: number; salary_max?: number; salary_currency?: string }
}

interface Envelope {
  data: FhJob[]
  meta?: { total?: number }
}

/** freehire's seniority vocabulary (verified via /api/v1/jobs/facets). */
const SENIORITY: Record<Level, string[]> = {
  intern: ["intern"],
  entry: ["junior"],
  mid: ["middle"],
  senior: ["senior"],
  staff: ["staff", "lead", "principal"],
}

/** freehire's city facet uses "New York City", not "New York". */
const CITY_ALIASES: Record<string, string[]> = {
  "new york": ["New York City", "New York"],
  nyc: ["New York City"],
  "san francisco": ["San Francisco", "South San Francisco"],
  sf: ["San Francisco"],
}

function cityFacets(city: string): string[] {
  const key = city.split(",")[0]!.trim().toLowerCase()
  return CITY_ALIASES[key] ?? [city.split(",")[0]!.trim()]
}

function enrichedSalary(e: FhJob["enrichment"]): Salary | null {
  if (e.salary_min == null && e.salary_max == null) return null
  if (e.salary_currency && e.salary_currency.toUpperCase() !== "USD") return null
  return { min: e.salary_min ?? null, max: e.salary_max ?? null, raw: `${e.salary_min ?? ""}–${e.salary_max ?? ""}`, kind: "structured" }
}

function toJob(j: FhJob): Job {
  const description = htmlToText(j.description)
  return {
    id: `freehire:${j.public_slug}`,
    source: "freehire",
    sourceId: j.public_slug,
    title: j.title.trim(),
    company: j.company || null,
    location: j.location || null,
    // freehire's `cities` enrichment can carry company-wide office cities (a Toronto-only
    // Stripe posting listed New York), so only the posting's own location string counts.
    locations: j.location ? [j.location] : [],
    workMode: workModeFrom(j.work_mode, j.location),
    url: j.url.replace(/[?&]utm_source=[^&]*/, ""),
    postedAt: j.posted_at ?? j.created_at ?? null,
    salary: enrichedSalary(j.enrichment) ?? parseSalary(description),
    yoeMin: parseYoe(description),
    level: levelFromTitle(j.title),
    fit: null,
    ai: null,
    description,
  }
}

export const freehire: Provider = {
  source: "freehire",
  async search(p: SearchParams, _ctx: ProviderCtx): Promise<Job[]> {
    const base = new URLSearchParams({ semantic_ratio: "0", countries: "us", description_format: "text" })
    if (p.days !== null) base.set("posted_within_days", String(p.days))
    if (p.levels) for (const s of p.levels.flatMap((l) => SENIORITY[l])) base.append("seniority", s)

    // Two passes when remote is "include": the cities facet excludes remote-US roles.
    const passes: URLSearchParams[] = []
    if (p.remote !== "only") {
      const city = new URLSearchParams(base)
      for (const c of cityFacets(p.city)) city.append("cities", c)
      passes.push(city)
    }
    if (p.remote !== "exclude") {
      const remote = new URLSearchParams(base)
      remote.set("work_mode", "remote")
      passes.push(remote)
    }

    const perQuery: Job[][] = []
    for (const query of p.queries) {
      for (const pass of passes) {
        const out: Job[] = []
        for (let offset = 0; offset < p.perSource; offset += PAGE_SIZE) {
          const q = new URLSearchParams(pass)
          q.set("q", query)
          q.set("limit", String(Math.min(PAGE_SIZE, p.perSource - offset)))
          q.set("offset", String(offset))
          const env = await getJson<Envelope>(`${BASE}/api/v1/agent/jobs/search?${q}`)
          if (!env) throw new Error("freehire agent search endpoint not found")
          const rows = env.data ?? []
          // The countries facet is applied server-side, but the record's own tag is what we trust.
          const batch = rows.filter((r) => !r.countries?.length || r.countries.includes("us")).map(toJob)
          out.push(...batch)
          if (rows.length < Math.min(PAGE_SIZE, p.perSource - offset)) break
        }
        perQuery.push(out)
      }
    }
    return unionById(perQuery).filter((j) => p.titleRe.test(j.title))
  },
  async detail(sourceId) {
    const env = await getJson<{ data: FhJob }>(`${BASE}/api/v1/jobs/${encodeURIComponent(sourceId)}`)
    return env?.data ? toJob(env.data) : null
  },
}
