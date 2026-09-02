import { getJson, pool } from "../http.ts"
import { levelFromTitle, parseSalary, parseYoe, workModeFrom } from "../text.ts"
import type { Company, Job, Salary, SearchParams } from "../types.ts"
import { boardCache, withinDays, type Provider, type ProviderCtx } from "./provider.ts"

interface LeverPosting {
  id: string
  text: string
  hostedUrl: string
  createdAt: number
  workplaceType?: string
  categories: { location?: string; allLocations?: string[]; commitment?: string; team?: string }
  descriptionPlain?: string
  additionalPlain?: string
  lists?: Array<{ text: string; content: string }>
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string }
}

/** Title-gated postings for one board, from cache or a fresh feed fetch. Null when the board doesn't exist. */
function boardJobs(company: Company, titleRe: RegExp, ctx: ProviderCtx): Promise<Job[] | null> {
  return boardCache(ctx, "lever", company.slug, titleRe, async () => {
    const body = await getJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(company.slug)}?mode=json`)
    return body ? body.filter((j) => titleRe.test(j.text)).map((j) => toJob(company, j)) : null
  })
}

function structuredSalary(r: LeverPosting["salaryRange"]): Salary | null {
  if (!r || (r.min == null && r.max == null)) return null
  if (r.currency && r.currency.toUpperCase() !== "USD") return null
  const factor = /hour/i.test(r.interval ?? "") ? 2080 : /month/i.test(r.interval ?? "") ? 12 : 1
  return {
    min: r.min == null ? null : r.min * factor,
    max: r.max == null ? null : r.max * factor,
    raw: `${r.currency ?? ""} ${r.min ?? ""}–${r.max ?? ""} ${r.interval ?? ""}`.trim(),
    kind: "structured",
  }
}

function toJob(company: Company, j: LeverPosting): Job {
  const listText = (j.lists ?? []).map((l) => `${l.text}\n${l.content.replace(/<[^>]+>/g, " ")}`).join("\n")
  const description = [j.descriptionPlain, listText, j.additionalPlain].filter(Boolean).join("\n\n").trim() || null
  const primary = j.categories.location ?? null
  const locations = [...new Set([primary, ...(j.categories.allLocations ?? [])].filter((s): s is string => !!s))]
  return {
    id: `lever:${company.slug}:${j.id}`,
    source: "lever",
    sourceId: `${company.slug}:${j.id}`,
    title: j.text.trim(),
    company: company.name,
    location: primary,
    locations,
    workMode: workModeFrom(j.workplaceType, primary),
    url: j.hostedUrl,
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    salary: structuredSalary(j.salaryRange) ?? parseSalary(description),
    yoeMin: parseYoe(description),
    level: levelFromTitle(j.text),
    fit: null,
    description,
  }
}

export const lever: Provider = {
  source: "lever",
  async search(p: SearchParams, ctx: ProviderCtx): Promise<Job[]> {
    const companies = ctx.companies.filter((c) => c.ats === "lever")
    const lists = await pool(companies, 8, (c) => boardJobs(c, p.titleRe, ctx).catch((e) => (ctx.log(`lever: ${c.slug} failed — ${e instanceof Error ? e.message : e}`), null)))
    return lists.flatMap((jobs) => (jobs ?? []).filter((j) => withinDays(j.postedAt, p.days)))
  },
  async detail(sourceId, ctx) {
    const [slug, id] = sourceId.split(":")
    if (!slug || !id) return null
    const company = ctx.companies.find((c) => c.ats === "lever" && c.slug === slug) ?? { name: slug, ats: "lever" as const, slug }
    const j = await getJson<LeverPosting>(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}/${id}?mode=json`)
    return j ? toJob(company, j) : null
  },
}
