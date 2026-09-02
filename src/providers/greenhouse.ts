import { getJson, pool } from "../http.ts"
import { decodeEntities, htmlToText, levelFromTitle, parseSalary, parseYoe, workModeFrom } from "../text.ts"
import type { Company, Job, SearchParams } from "../types.ts"
import { boardCache, withinDays, type Provider, type ProviderCtx } from "./provider.ts"

interface GhJob {
  id: number
  title: string
  absolute_url: string
  location: { name: string } | null
  offices?: Array<{ name: string }>
  content: string
  first_published: string | null
  updated_at: string
  company_name?: string
}

interface GhFeed {
  jobs: GhJob[]
}

/** Title-gated postings for one board, from cache or a fresh feed fetch. Null when the board doesn't exist. */
function boardJobs(company: Company, titleRe: RegExp, ctx: ProviderCtx): Promise<Job[] | null> {
  return boardCache(ctx, "greenhouse", company.slug, titleRe, async () => {
    const body = await getJson<GhFeed>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.slug)}/jobs?content=true`)
    return body ? body.jobs.filter((j) => titleRe.test(j.title)).map((j) => toJob(company, j)) : null
  })
}

function toJob(company: Company, j: GhJob): Job {
  // Greenhouse ships `content` entity-escaped (&lt;div&gt;…), so decode once before stripping tags.
  const description = htmlToText(decodeEntities(j.content))
  const locations = [j.location?.name, ...(j.offices ?? []).map((o) => o.name)].filter((s): s is string => !!s)
  return {
    id: `greenhouse:${company.slug}:${j.id}`,
    source: "greenhouse",
    sourceId: `${company.slug}:${j.id}`,
    title: j.title.trim(),
    company: company.name,
    location: j.location?.name ?? null,
    locations,
    workMode: workModeFrom(j.location?.name, j.title),
    url: j.absolute_url,
    postedAt: j.first_published ?? j.updated_at ?? null,
    salary: parseSalary(description),
    yoeMin: parseYoe(description),
    level: levelFromTitle(j.title),
    fit: null,
    ai: null,
    description,
  }
}

export const greenhouse: Provider = {
  source: "greenhouse",
  async search(p: SearchParams, ctx: ProviderCtx): Promise<Job[]> {
    const companies = ctx.companies.filter((c) => c.ats === "greenhouse")
    const lists = await pool(companies, 8, (c) => boardJobs(c, p.titleRe, ctx).catch((e) => (ctx.log(`greenhouse: ${c.slug} failed — ${e instanceof Error ? e.message : e}`), null)))
    return lists.flatMap((jobs) => (jobs ?? []).filter((j) => withinDays(j.postedAt, p.days)))
  },
  async detail(sourceId, ctx) {
    const [slug, id] = sourceId.split(":")
    if (!slug || !id) return null
    const company = ctx.companies.find((c) => c.ats === "greenhouse" && c.slug === slug) ?? { name: slug, ats: "greenhouse" as const, slug }
    const j = await getJson<GhJob>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs/${id}`)
    return j ? toJob(company, j) : null
  },
}
