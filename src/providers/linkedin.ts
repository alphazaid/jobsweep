// LinkedIn's public, unauthenticated "jobs-guest" endpoints. There is no public job
// API; automated access to these pages is against LinkedIn's terms. The connector is
// therefore OFF by default, runs only on the user's own machine after they accept the
// notice (`jobsweep init` or `linkedinAccepted: true`), and keeps volume low (small
// pages, 2 detail fetches in flight, backoff on 429, 14-day detail cache).
import { getText, pool } from "../http.ts"
import { decodeEntities, htmlToText, levelFromTitle, parseSalary, parseYoe, workModeFrom } from "../text.ts"
import { ProviderError, type Job, type Level, type SearchParams } from "../types.ts"
import type { Provider, ProviderCtx } from "./provider.ts"

export const LINKEDIN_OPT_IN_ERROR =
  "LinkedIn connector is off: it reads LinkedIn's public job pages from your machine, which LinkedIn's terms prohibit automating. " +
  "Enable it for personal use only with `jobsweep init` (LinkedIn step) or `--linkedin`, or drop \"linkedin\" from sources."

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
const DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting"
const PAGE_SIZE = 10
const HEADERS = { Accept: "text/html", "X-Requested-With": "XMLHttpRequest" }
const DETAIL_TTL_MS = 14 * 24 * 60 * 60 * 1000
/** How recently a carried posting must have been checked to count as still open without a refetch. */
const REVALIDATE_TTL_MS = 3 * 24 * 60 * 60 * 1000

/** LinkedIn experience-level facet (f_E): 1 internship, 2 entry, 3 associate, 4 mid-senior, 5 director. */
const F_E: Record<Level, string[]> = {
  intern: ["1"],
  entry: ["2", "3"],
  mid: ["3", "4"],
  senior: ["4"],
  staff: ["4", "5"],
}

const WT: Record<SearchParams["remote"], string | null> = { include: null, only: "2", exclude: null }

function clean(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

interface Card {
  id: string
  title: string
  company: string | null
  location: string | null
  date: string | null
  url: string
}

export function parseCards(html: string): Card[] {
  const cards: Card[] = []
  for (const chunk of html.split(/data-entity-urn="urn:li:jobPosting:/).slice(1)) {
    const id = /^(\d+)/.exec(chunk)?.[1]
    if (!id) continue
    const title =
      /class="base-search-card__title"[^>]*>([\s\S]*?)<\/h3>/i.exec(chunk)?.[1] ??
      /class="sr-only"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk)?.[1]
    if (!title) continue
    const sub = /class="base-search-card__subtitle"[^>]*>([\s\S]*?)<\/h4>/i.exec(chunk)?.[1]
    const loc = /class="job-search-card__location"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk)?.[1]
    const date = /class="job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i.exec(chunk)?.[1]
    cards.push({
      id,
      title: clean(title),
      company: sub ? clean(sub) || null : null,
      location: loc ? clean(loc) || null : null,
      date: date ?? null,
      url: `https://www.linkedin.com/jobs/view/${id}`,
    })
  }
  return cards
}

/** Inner HTML of the first div carrying `className`, depth-aware so nested divs don't truncate it. */
function divContent(html: string, className: string): string | null {
  const open = new RegExp(`<div[^>]*class="[^"]*${className}[^"]*"[^>]*>`, "i").exec(html)
  if (!open) return null
  let i = open.index + open[0].length
  let depth = 1
  while (depth > 0) {
    const nextOpen = html.indexOf("<div", i)
    const nextClose = html.indexOf("</div>", i)
    if (nextClose === -1) return null
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      i = nextOpen + 4
    } else {
      depth--
      i = nextClose + 6
    }
  }
  return html.slice(open.index + open[0].length, i - 6)
}

interface Detail {
  description: string | null
  salaryText: string | null
  seniority: string | null
  closed: boolean
}

export function parseDetail(html: string): Detail {
  const descHtml = divContent(html, "show-more-less-html__markup") ?? divContent(html, "description__text")
  const salaryText = /class="compensation__salary"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1]
  const crit: Record<string, string> = {}
  const re =
    /class="description__job-criteria-subheader"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?class="description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/gi
  for (const m of html.matchAll(re)) crit[clean(m[1]!).toLowerCase()] = clean(m[2]!)
  const descStart = html.search(/class="(?:show-more-less-html__markup|description__text)/i)
  const topcard = descStart === -1 ? html : html.slice(0, descStart)
  return {
    description: htmlToText(descHtml),
    salaryText: salaryText ? clean(salaryText) : null,
    seniority: crit["seniority level"] ?? null,
    closed: /closed-job__flavor|no longer accepting applications/i.test(topcard),
  }
}

function toJob(card: Card, d: Detail | null): Job {
  const text = d ? [d.salaryText, d.description].filter(Boolean).join("\n") : null
  return {
    id: `linkedin:${card.id}`,
    source: "linkedin",
    sourceId: card.id,
    title: card.title,
    company: card.company,
    location: card.location,
    locations: card.location ? [card.location] : [],
    workMode: workModeFrom(card.title, card.location, d?.description?.slice(0, 600)),
    url: card.url,
    postedAt: card.date,
    salary: parseSalary(text),
    yoeMin: parseYoe(d?.description),
    level: levelFromTitle(card.title),
    fit: null,
    ai: null,
    description: d?.description ?? null,
  }
}

/** A 404 means the posting was removed; represent it as a closed Detail so it is cached and dropped, not refetched every run. */
const GONE: Detail = { description: null, salaryText: null, seniority: null, closed: true }

async function fetchDetail(id: string): Promise<Detail> {
  const html = await getText(`${DETAIL_URL}/${id}`, { headers: HEADERS })
  return html ? parseDetail(html) : GONE
}

/** Detail from the feed cache if younger than `maxAgeMs`, else fetched and re-cached. `detail: null` = fetch threw. */
async function cachedDetail(id: string, maxAgeMs: number, ctx: ProviderCtx): Promise<{ detail: Detail | null; hit: boolean }> {
  const key = `linkedin:detail:${id}`
  const hit = ctx.cache.get(key, maxAgeMs)
  if (hit) return { detail: JSON.parse(hit) as Detail, hit: true }
  try {
    const d = await fetchDetail(id)
    ctx.cache.set(key, JSON.stringify(d))
    return { detail: d, hit: false }
  } catch (e) {
    ctx.log(`linkedin: detail ${id} failed: ${e instanceof Error ? e.message : e}`)
    return { detail: null, hit: false }
  }
}

export const linkedin: Provider = {
  source: "linkedin",
  async search(p: SearchParams, ctx: ProviderCtx): Promise<Job[]> {
    if (!p.linkedinAccepted) throw new ProviderError("linkedin", LINKEDIN_OPT_IN_ERROR)
    // No salary facet (f_SB2): it drops every posting that doesn't declare pay to
    // LinkedIn, which is most of them. Comp is filtered client-side instead.
    const base = new URLSearchParams({ location: p.city })
    if (p.levels) base.set("f_E", [...new Set(p.levels.flatMap((l) => F_E[l]))].join(","))
    if (p.days !== null) base.set("f_TPR", `r${p.days * 86_400}`)
    const wt = WT[p.remote]
    if (wt) base.set("f_WT", wt)

    const byId: Record<string, Card> = {}
    const pages = Math.ceil(p.perSource / PAGE_SIZE)
    for (const query of p.queries) {
      const q = new URLSearchParams(base)
      q.set("keywords", query)
      for (let page = 0; page < pages; page++) {
        q.set("start", String(page * PAGE_SIZE))
        const html = await getText(`${SEARCH_URL}?${q}`, { headers: HEADERS })
        const batch = html ? parseCards(html) : []
        for (const c of batch) byId[c.id] ??= c
        if (batch.length < PAGE_SIZE) break
      }
    }
    // Gate on title before spending a detail fetch on it.
    const cards = Object.values(byId).filter((c) => p.titleRe.test(c.title))
    if (!p.hydrate) return cards.map((c) => toJob(c, null))

    // Parsed details are cached (feed cache, 14 d) whether or not the posting
    // survives filtering, so a run only hits LinkedIn for postings it has never opened.
    let hits = 0
    const details = await pool(cards, 2, async (c) => {
      const r = await cachedDetail(c.id, DETAIL_TTL_MS, ctx)
      if (r.hit) hits++
      return r.detail
    })
    ctx.log(`linkedin: ${cards.length} titled cards, ${hits} cached, ${cards.length - hits} fetched`)
    const open: Job[] = []
    cards.forEach((c, i) => {
      const d = details[i] ?? null
      if (d?.closed) ctx.retire(`linkedin:${c.id}`)
      else open.push(toJob(c, d))
    })
    return open
  },
  async revalidate(sourceIds, ctx) {
    // A detail checked within REVALIDATE_TTL_MS counts as confirmed; older ones are refetched (bounded: only carried rows).
    const details = await pool(sourceIds, 2, (id) => cachedDetail(id, REVALIDATE_TTL_MS, ctx).then((r) => r.detail))
    const open = new Set<string>()
    sourceIds.forEach((id, i) => {
      const d = details[i]
      if (d?.closed) ctx.retire(`linkedin:${id}`)
      else if (d) open.add(id)
      // d === null: fetch threw (rate limit); unknown state → not confirmed this run, not retired.
    })
    return open
  },
  async detail(sourceId) {
    const id = /(\d{6,})/.exec(sourceId)?.[1]
    if (!id) return null
    const html = await getText(`${DETAIL_URL}/${id}`, { headers: HEADERS })
    if (!html) return null
    const d = parseDetail(html)
    const title = /class="(?:top-card-layout__title|topcard__title)[^"]*"[^>]*>([\s\S]*?)<\/h[12]>/i.exec(html)?.[1]
    const company = /class="topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1]
    const loc = /class="topcard__flavor topcard__flavor--bullet"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1]
    return toJob(
      {
        id,
        title: title ? clean(title) : "(untitled)",
        company: company ? clean(company) : null,
        location: loc ? clean(loc) : null,
        date: null,
        url: `https://www.linkedin.com/jobs/view/${id}`,
      },
      d,
    )
  },
}
