import type { Company, Job, SearchParams, Source } from "../types.ts"

export interface FeedCache {
  get(key: string, maxAgeMs: number): string | null
  set(key: string, body: string): void
}

export interface ProviderCtx {
  companies: Company[]
  cache: FeedCache
  /** The source reports this posting closed or removed: forget it so no later run carries it forward. */
  retire: (id: string) => void
  /** Diagnostics go to stderr so stdout stays machine-readable. */
  log: (msg: string) => void
  /** Provider registry override (tests inject fakes); the CLI leaves it unset to use every real provider. */
  providers?: Partial<Record<Source, Provider>>
}

export interface Provider {
  source: Source
  search(p: SearchParams, ctx: ProviderCtx): Promise<Job[]>
  /** Full posting by source id; null when the source cannot find it. */
  detail?(sourceId: string, ctx: ProviderCtx): Promise<Job | null>
  /**
   * For sampled sources: which of these previously seen postings are still open.
   * Must retire (via ctx.retire) any found closed. Cheap when recently checked.
   */
  revalidate?(sourceIds: string[], ctx: ProviderCtx): Promise<Set<string>>
}

/** Board feeds are company-wide; cache them so a 4 MB Greenhouse dump is fetched once per TTL. */
export const FEED_TTL_MS = 6 * 60 * 60 * 1000

export function withinDays(iso: string | null, days: number | null, now: number = Date.now()): boolean {
  if (days === null || !iso) return true
  const t = Date.parse(iso)
  return Number.isNaN(t) || now - t <= days * 86_400_000
}

/** Union of per-query result lists, deduped by job id, preserving first-seen order. */
export function unionById(lists: Job[][]): Job[] {
  const seen: Record<string, true> = {}
  const out: Job[] = []
  for (const j of lists.flat()) {
    if (seen[j.id]) continue
    seen[j.id] = true
    out.push(j)
  }
  return out
}

/** Postings older than this never enter the board cache: boards keep evergreen reqs for years, and no search asks that far back. */
const CACHE_MAX_AGE_DAYS = 90
/** Description text kept per cached posting; requirements sections sit well inside this, and it bounds the DB (~2 KB/posting). */
const CACHE_DESC_CHARS = 6_000

/**
 * Cache for company boards. Raw feeds are huge (a large employer's Greenhouse dump
 * is 20–45 MB), so what is cached is the mapped, title-gated posting list, bounded
 * by age and description length. The key includes the title gate so a changed preset misses.
 */
export async function boardCache(
  ctx: ProviderCtx,
  source: Source,
  slug: string,
  titleRe: RegExp,
  load: () => Promise<Job[] | null>,
): Promise<Job[] | null> {
  const key = `${source}:${slug}:${Bun.hash(titleRe.source).toString(36)}`
  const hit = ctx.cache.get(key, FEED_TTL_MS)
  if (hit) return JSON.parse(hit) as Job[]
  const jobs = (await load())
    ?.filter((j) => withinDays(j.postedAt, CACHE_MAX_AGE_DAYS))
    .map((j) => (j.description && j.description.length > CACHE_DESC_CHARS ? { ...j, description: j.description.slice(0, CACHE_DESC_CHARS) } : j))
  if (jobs) ctx.cache.set(key, JSON.stringify(jobs))
  return jobs ?? null
}
