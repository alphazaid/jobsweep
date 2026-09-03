// Company-board discovery. freehire indexes postings from Greenhouse, Lever, and
// Ashby and keeps the original URL, so a broad sweep of its NYC/remote engineering
// postings yields the board slugs of every company hiring there — far more than a
// hand-curated list, and each one then gets polled directly (structured comp, no
// rate limits).
import { getJson } from "./http.ts"
import { AGENCY_RE, type Company } from "./types.ts"

const BASE = (process.env.FREEHIRE_API_URL ?? "https://freehire.me").replace(/\/+$/, "")
const PAGE = 100

interface FhLite {
  url: string
  company: string
  source: string
}

/** Board slug from a posting URL, per ATS. Returns null for non-board hosts (company career sites, other ATSs). */
export function slugFromUrl(url: string): Company | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const seg = u.pathname.split("/").filter(Boolean)
  if (/(^|\.)greenhouse\.io$/.test(u.hostname)) {
    // boards.greenhouse.io/<slug>/jobs/<id>, job-boards.greenhouse.io/<slug>/jobs/<id>, job-boards.eu.greenhouse.io/...
    return seg[0] && seg[1] === "jobs" ? { name: "", ats: "greenhouse", slug: seg[0] } : null
  }
  if (u.hostname === "jobs.lever.co") return seg[0] ? { name: "", ats: "lever", slug: seg[0] } : null
  if (u.hostname === "jobs.ashbyhq.com") return seg[0] ? { name: "", ats: "ashby", slug: seg[0] } : null
  // Career pages embedding a Greenhouse board expose the job id as ?gh_jid=; the slug isn't recoverable from that.
  return null
}

export interface Discovered extends Company {
  /** Postings seen on freehire for this board during the sweep — a rough "how much are they hiring here" signal. */
  postings: number
}

/**
 * Sweep freehire for postings in the preset's categories in `cities` (plus remote-US) and collect the ATS boards
 * behind them. `categories` come from the preset (`discoverCategories`); `queries` seed the text search — the first
 * query's last word ("engineer", "nurse", "analyst") is the broadest net for a field.
 */
export async function discoverBoards(cities: string[], opts: { pages: number; days: number; categories: string[]; queries: string[]; log: (m: string) => void }): Promise<Discovered[]> {
  if (!opts.categories.length) {
    opts.log("discover: this preset has no freehire categories — add boards to companies.json by hand, or set discoverCategories in a custom preset")
    return []
  }
  const term = opts.queries[0]?.split(/\s+/).pop() ?? ""
  const passes: URLSearchParams[] = []
  for (const city of cities) passes.push(new URLSearchParams({ countries: "us", cities: city }))
  passes.push(new URLSearchParams({ countries: "us", work_mode: "remote" }))

  const found: Record<string, Discovered> = {}
  for (const pass of passes) {
    for (const category of opts.categories) {
      pass.set("category", category)
      for (let page = 0; page < opts.pages; page++) {
        const q = new URLSearchParams(pass)
        if (term) q.set("q", term)
        q.set("semantic_ratio", "0")
        q.set("limit", String(PAGE))
        q.set("offset", String(page * PAGE))
        q.set("include_description", "false")
        q.set("posted_within_days", String(opts.days))
        const env = await getJson<{ data: FhLite[] }>(`${BASE}/api/v1/agent/jobs/search?${q}`)
        const rows = env?.data ?? []
        for (const r of rows) {
          const c = slugFromUrl(r.url)
          // Agencies and aggregators run huge boards of reposted jobs; never poll them.
          if (!c || AGENCY_RE.test(r.company ?? "") || AGENCY_RE.test(c.slug)) continue
          const key = `${c.ats}:${c.slug}`
          found[key] ??= { ...c, name: r.company || c.slug, postings: 0 }
          found[key].postings++
        }
        if (rows.length < PAGE) break
      }
    }
    opts.log(`discover: ${pass.get("cities") ?? "remote"} → ${Object.keys(found).length} boards so far`)
  }
  return Object.values(found).sort((a, b) => b.postings - a.postings)
}
