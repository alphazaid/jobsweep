import type { Store } from "./db.ts"
import { applyFilters, dedupe, type FilterResult } from "./filters.ts"
import type { Profile } from "./profile.ts"
import { PROVIDERS } from "./providers/index.ts"
import { withinDays, type ProviderCtx } from "./providers/provider.ts"
import { isHttpUrl } from "./text.ts"
import { AGENCY_RE, ProviderError, type Job, type SearchParams, type Source } from "./types.ts"

export interface RunResult {
  jobs: Job[]
  dropped: Record<"city" | "tc" | "experience" | "excluded", number>
  errors: Array<{ source: string; error: string }>
  /** Ids seen for the first time this run. */
  newIds: Record<string, true>
  /** Ids not returned by their source this run but carried from an earlier one (sampled sources only). */
  carriedIds: Record<string, true>
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Attach profile-skill matches to each job (word-boundary match over title + description). */
export function scoreFit(jobs: Job[], skills: string[]): Job[] {
  if (!skills.length) return jobs
  const res = skills.map((s) => [s, new RegExp(`(?<![a-z0-9+#])${escapeRe(s.toLowerCase())}(?![a-z0-9])`, "i")] as const)
  return jobs.map((j) => {
    const text = `${j.title}\n${j.description ?? ""}`
    const matched = res.filter(([, re]) => re.test(text)).map(([s]) => s)
    return { ...j, fit: { matched, total: skills.length } }
  })
}

async function fetchAll(p: SearchParams, ctx: ProviderCtx, errors: RunResult["errors"]): Promise<Job[]> {
  const perSource = await Promise.all(
    p.sources.map(async (s) => {
      const t0 = Date.now()
      try {
        const jobs = await (ctx.providers?.[s] ?? PROVIDERS[s]).search(p, ctx)
        ctx.log(`${s} [${p.city}]: ${jobs.length} candidates in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
        return jobs
      } catch (e) {
        const msg = e instanceof ProviderError ? e.message : `${e instanceof Error ? e.message : e}`
        if (!errors.some((x) => x.source === s && x.error === msg)) errors.push({ source: s, error: msg })
        ctx.log(`${s} [${p.city}]: skipped — ${msg}`)
        return []
      }
    }),
  )
  return perSource.flat()
}

/** Sources whose search is a sample of matching postings rather than a listing; each call returns a different subset. */
const SAMPLED_SOURCES: Source[] = ["linkedin"]
/** How long a sampled-source posting is carried after its last live observation when no freshness window is set. */
const DEFAULT_CARRY_DAYS = 14

/**
 * One search across every city in `params` (each city is its own provider pass —
 * board feeds are cached, so extra cities cost only LinkedIn/freehire/Adzuna calls).
 * Results are deduped across sources and cities, filtered, scored, and recorded.
 *
 * Sampled sources are then topped up from the store: postings they returned in an
 * earlier run (within the freshness window) that still pass today's filters are
 * carried into the result so the set converges instead of flickering. Carried rows
 * are NOT re-recorded — `last_seen` only ever reflects a live observation, so a
 * posting the source stops returning ages out at the window, and one the source
 * reports closed is retired by the provider and never carried.
 */
export async function run(paramsPerCity: SearchParams[], profile: Pick<Profile, "skills" | "exclude">, ctx: ProviderCtx, store: Store): Promise<RunResult> {
  const errors: RunResult["errors"] = []
  const dropped = { city: 0, tc: 0, experience: 0, excluded: 0 }
  const byId: Record<string, Job> = {}
  const exclude = profile.exclude.length ? new RegExp(`\\b(${profile.exclude.map(escapeRe).join("|")})\\b`, "i") : null
  const keep = (r: FilterResult, into: Record<string, Job>) => {
    dropped.city += r.dropped.city
    dropped.tc += r.dropped.tc
    dropped.experience += r.dropped.experience
    for (const j of r.kept) {
      if (exclude?.test(j.title) || AGENCY_RE.test(j.company ?? "")) {
        dropped.excluded++
        continue
      }
      into[j.id] ??= j
    }
  }

  for (const p of paramsPerCity) keep(applyFilters(dedupe(await fetchAll(p, ctx, errors)), p), byId)
  // Provider URLs are fetched text. Only http(s) links reach the UI's "Open posting" and the exports; anything else is junk.
  const live = scoreFit(dedupe(Object.values(byId).filter((j) => isHttpUrl(j.url))), profile.skills)
  const newIds = store.record(live)

  const carriedById: Record<string, Job> = {}
  const liveIds: Record<string, true> = {}
  for (const j of live) liveIds[j.id] = true
  for (const p of paramsPerCity) {
    const sampled = SAMPLED_SOURCES.filter((s) => p.sources.includes(s))
    if (!sampled.length) continue
    const since = store.now() - (p.days ?? DEFAULT_CARRY_DAYS) * 86_400_000
    for (const s of sampled) {
      // Honor the posting-date window too (providers apply it on live results; carried rows must not bypass it),
      // and never carry a posting whose date is unknown — the window can't be checked.
      const prior = store
        .recent(`${s}:`, since)
        .filter((j) => !liveIds[j.id] && j.postedAt !== null && withinDays(j.postedAt, p.days ?? DEFAULT_CARRY_DAYS, store.now()))
      if (!prior.length) continue
      // Re-confirm each carried posting is still open before it is shown as such.
      const provider = ctx.providers?.[s] ?? PROVIDERS[s]
      const open = provider.revalidate ? await provider.revalidate(prior.map((j) => j.sourceId), ctx) : new Set(prior.map((j) => j.sourceId))
      keep(applyFilters(prior.filter((j) => open.has(j.sourceId)), p), carriedById)
    }
  }
  // Same URL guard as live: rows stored before it existed would otherwise re-enter through carry-forward.
  const carried = scoreFit(dedupe(Object.values(carriedById).filter((j) => isHttpUrl(j.url))), profile.skills).filter((j) => !liveIds[j.id])
  const carriedIds: Record<string, true> = {}
  for (const j of carried) carriedIds[j.id] = true
  if (carried.length) ctx.log(`carry-forward: ${carried.length} postings from earlier runs still pass today's filters`)

  const jobs = dedupe([...live, ...carried])
  store.recordRun({ cities: paramsPerCity.map((p) => p.city), total: jobs.length, withComp: jobs.filter((j) => j.salary).length, newCount: Object.keys(newIds).length, carried: carried.length })
  return { jobs, dropped, errors, newIds, carriedIds }
}
