import { getJson, pool } from "../http.ts"
import { levelFromTitle, parseSalary, parseYoe, workModeFrom } from "../text.ts"
import type { Company, Job, Salary, SearchParams } from "../types.ts"
import { boardCache, withinDays, type Provider, type ProviderCtx } from "./provider.ts"

interface AshbyComponent {
  compensationType: string
  interval: string
  currencyCode: string | null
  minValue: number | null
  maxValue: number | null
}

interface AshbyJob {
  id: string
  title: string
  location: string
  secondaryLocations?: Array<{ location: string }>
  publishedAt: string
  isListed: boolean
  isRemote: boolean
  workplaceType?: string
  jobUrl: string
  descriptionPlain?: string
  compensation?: {
    compensationTierSummary?: string
    compensationTiers?: Array<{ components: AshbyComponent[] }>
  }
}

interface AshbyFeed {
  jobs: AshbyJob[]
}

/** Title-gated, listed postings for one board, from cache or a fresh feed fetch. Null when the board doesn't exist. */
function boardJobs(company: Company, titleRe: RegExp, ctx: ProviderCtx): Promise<Job[] | null> {
  return boardCache(ctx, "ashby", company.slug, titleRe, async () => {
    const body = await getJson<AshbyFeed>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.slug)}?includeCompensation=true`)
    return body ? body.jobs.filter((j) => j.isListed && titleRe.test(j.title)).map((j) => toJob(company, j)) : null
  })
}

/** Highest USD salary tier across the posting's compensation tiers. */
function structuredSalary(c: AshbyJob["compensation"]): Salary | null {
  if (!c?.compensationTiers?.length) return null
  let best: Salary | null = null
  for (const tier of c.compensationTiers) {
    for (const comp of tier.components) {
      if (comp.compensationType !== "Salary") continue
      if (comp.currencyCode && comp.currencyCode !== "USD") continue
      const factor = /hour/i.test(comp.interval) ? 2080 : /month/i.test(comp.interval) ? 12 : 1
      const max = comp.maxValue == null ? null : comp.maxValue * factor
      const min = comp.minValue == null ? null : comp.minValue * factor
      if (max === null && min === null) continue
      if (!best || (max ?? min ?? 0) > (best.max ?? best.min ?? 0)) {
        best = { min, max, raw: c.compensationTierSummary ?? `${min}–${max}`, kind: "structured" }
      }
    }
  }
  return best
}

function toJob(company: Company, j: AshbyJob): Job {
  const description = j.descriptionPlain?.trim() || null
  const locations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean)
  return {
    id: `ashby:${company.slug}:${j.id}`,
    source: "ashby",
    sourceId: `${company.slug}:${j.id}`,
    title: j.title.trim(),
    company: company.name,
    location: j.location,
    locations,
    workMode: workModeFrom(j.workplaceType, j.isRemote ? "remote" : null, j.location),
    url: j.jobUrl,
    postedAt: j.publishedAt ?? null,
    salary: structuredSalary(j.compensation) ?? parseSalary(description),
    yoeMin: parseYoe(description),
    level: levelFromTitle(j.title),
    fit: null,
    description,
  }
}

export const ashby: Provider = {
  source: "ashby",
  async search(p: SearchParams, ctx: ProviderCtx): Promise<Job[]> {
    const companies = ctx.companies.filter((c) => c.ats === "ashby")
    const lists = await pool(companies, 8, (c) => boardJobs(c, p.titleRe, ctx).catch((e) => (ctx.log(`ashby: ${c.slug} failed — ${e instanceof Error ? e.message : e}`), null)))
    return lists.flatMap((jobs) => (jobs ?? []).filter((j) => withinDays(j.postedAt, p.days)))
  },
  async detail(sourceId, ctx) {
    const [slug, id] = sourceId.split(":")
    if (!slug || !id) return null
    const company = ctx.companies.find((c) => c.ats === "ashby" && c.slug === slug) ?? { name: slug, ats: "ashby" as const, slug }
    // Ashby has no single-posting endpoint; one uncached board fetch is fine for an explicit `detail`.
    const f = await getJson<AshbyFeed>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`)
    const j = f?.jobs.find((x) => x.id === id)
    return j ? toJob(company, j) : null
  },
}
