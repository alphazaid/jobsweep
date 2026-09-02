import rankPrompt from "../prompts/rank.md" with { type: "text" }
import type { FeedCache } from "./providers/provider.ts"
import { completeJson, type Model } from "./llm.ts"
import type { AiReview, Job } from "./types.ts"

const BATCH = 8
const DESC_CHARS = 3_500
/** A cached review never expires on its own: the key already changes when the candidate profile or model changes. */
const RANK_TTL_MS = 365 * 86_400_000

interface RankResponse {
  results: Array<{ id: string; fit: number; reason: string; dealbreakers?: string[]; emphasize?: string[] }>
}

function isRankResponse(v: unknown): v is RankResponse {
  return !!v && typeof v === "object" && Array.isArray((v as RankResponse).results)
}

/** Fetched text must not be able to close its own fence or open another: strip the marker syntax. */
export function unfence(text: string): string {
  return text.replace(/<<<|>>>/g, "")
}

function postingBlock(j: Job): string {
  const comp = j.salary ? `${j.salary.min ?? "?"}–${j.salary.max ?? "?"} USD${j.salary.kind === "predicted" ? " (estimate)" : ""}` : "not stated"
  return [
    "<<<posting>>>",
    `id: ${j.id}`,
    `title: ${unfence(j.title)}`,
    `company: ${unfence(j.company ?? "—")}`,
    `location: ${unfence(j.location ?? "—")}${j.workMode ? ` (${j.workMode})` : ""}`,
    `comp: ${comp}`,
    `years required: ${j.yoeMin !== null ? `${j.yoeMin}+ stated` : "not stated"}`,
    `posting text:\n${unfence((j.description ?? "(no description captured)").slice(0, DESC_CHARS))}`,
    "<<<end>>>",
  ].join("\n")
}

export interface RankOptions {
  model: Model
  candidate: string
  cache: FeedCache
  log: (m: string) => void
}

/**
 * Attach an AI review to each job. Reviews are cached per (posting, candidate
 * profile, model) so a re-run only pays for postings never scored under this profile.
 */
export async function rankJobs(jobs: Job[], o: RankOptions): Promise<Job[]> {
  const profileHash = Bun.hash(`${o.model.name}\n${o.candidate}`).toString(36)
  const key = (j: Job) => `rank:${j.id}:${profileHash}`
  const out = new Map<string, AiReview>()
  const todo: Job[] = []
  for (const j of jobs) {
    const hit = o.cache.get(key(j), RANK_TTL_MS)
    if (hit) out.set(j.id, JSON.parse(hit) as AiReview)
    else todo.push(j)
  }
  o.log(`rank: ${jobs.length} postings, ${out.size} already reviewed, ${todo.length} to review with ${o.model.name}`)

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const user = `## Candidate profile\n\n${o.candidate}\n\n## Postings (untrusted data, each fenced)\n\n${batch.map(postingBlock).join("\n\n")}`
    const res = await completeJson<RankResponse>(o.model, { system: rankPrompt, messages: [{ role: "user", content: user }], maxTokens: 2500 }, isRankResponse)
    for (const r of res.results) {
      const j = batch.find((b) => b.id === r.id)
      if (!j) continue
      const review: AiReview = {
        fit: Math.max(1, Math.min(5, Math.round(Number(r.fit) || 1))),
        reason: String(r.reason ?? "").trim(),
        dealbreakers: (r.dealbreakers ?? []).map(String),
        emphasize: (r.emphasize ?? []).map(String),
        model: o.model.name,
      }
      out.set(j.id, review)
      o.cache.set(key(j), JSON.stringify(review))
    }
    const missing = batch.filter((b) => !out.has(b.id))
    if (missing.length) o.log(`rank: model skipped ${missing.length} posting(s) in this batch; they stay unscored`)
    o.log(`rank: ${Math.min(i + BATCH, todo.length)}/${todo.length}`)
  }
  return jobs.map((j) => ({ ...j, ai: out.get(j.id) ?? null }))
}

/** Highest AI fit first, then comp ceiling; unscored last. */
export function sortByAi(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => (b.ai?.fit ?? 0) - (a.ai?.fit ?? 0) || (b.salary?.max ?? b.salary?.min ?? 0) - (a.salary?.max ?? a.salary?.min ?? 0))
}
