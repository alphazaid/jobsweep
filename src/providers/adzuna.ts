// Adzuna US job search API. Needs a free key pair: https://developer.adzuna.com
// Set ADZUNA_APP_ID and ADZUNA_APP_KEY (or put them in ./.env; bun loads it).
import { getJson } from "../http.ts"
import { htmlToText, levelFromTitle, parseSalary, parseYoe, workModeFrom } from "../text.ts"
import { ProviderError, type Job, type SearchParams } from "../types.ts"
import { unionById, type Provider, type ProviderCtx } from "./provider.ts"

interface AdzunaResult {
  id: string
  title: string
  redirect_url: string
  created: string
  description: string
  company?: { display_name?: string }
  location?: { display_name?: string; area?: string[] }
  salary_min?: number
  salary_max?: number
  salary_is_predicted?: string
}

interface AdzunaPage {
  results: AdzunaResult[]
  count: number
}

const PAGE_SIZE = 50

function toJob(r: AdzunaResult): Job {
  const description = htmlToText(r.description)
  const hasSalary = r.salary_min != null || r.salary_max != null
  const location = r.location?.display_name ?? null
  return {
    id: `adzuna:${r.id}`,
    source: "adzuna",
    sourceId: r.id,
    title: htmlToText(r.title) ?? r.title,
    company: r.company?.display_name ?? null,
    location,
    locations: location ? [location] : [],
    workMode: workModeFrom(r.title, location, description?.slice(0, 400)),
    url: r.redirect_url,
    postedAt: r.created ?? null,
    salary: hasSalary
      ? {
          min: r.salary_min ?? null,
          max: r.salary_max ?? null,
          raw: `${r.salary_min ?? ""}–${r.salary_max ?? ""}`,
          kind: r.salary_is_predicted === "1" ? "predicted" : "structured",
        }
      : parseSalary(description),
    yoeMin: parseYoe(description),
    level: levelFromTitle(r.title),
    fit: null,
    description,
  }
}

export const adzuna: Provider = {
  source: "adzuna",
  async search(p: SearchParams, _ctx: ProviderCtx): Promise<Job[]> {
    const id = process.env.ADZUNA_APP_ID
    const key = process.env.ADZUNA_APP_KEY
    if (!id || !key) throw new ProviderError("adzuna", "ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipping (free key at developer.adzuna.com)")
    // No salary_min: Adzuna's floor drops postings without a salary field. Comp is filtered client-side.
    const base = new URLSearchParams({ app_id: id, app_key: key, results_per_page: String(PAGE_SIZE), "content-type": "application/json" })
    if (p.remote !== "only") base.set("where", p.city)
    else base.set("what_and", "remote")
    if (p.days !== null) base.set("max_days_old", String(p.days))
    const pages = Math.ceil(p.perSource / PAGE_SIZE)
    const perQuery: Job[][] = []
    for (const query of p.queries) {
      const q = new URLSearchParams(base)
      q.set("what", query)
      const out: Job[] = []
      for (let page = 1; page <= pages; page++) {
        const body = await getJson<AdzunaPage>(`https://api.adzuna.com/v1/api/jobs/us/search/${page}?${q}`)
        if (!body) break
        out.push(...body.results.map(toJob))
        if (body.results.length < PAGE_SIZE) break
      }
      perQuery.push(out.slice(0, p.perSource))
    }
    return unionById(perQuery).filter((j) => p.titleRe.test(j.title))
  },
}
