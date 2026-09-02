import rankPrompt from "../prompts/rank.md" with { type: "text" }
import type { FeedCache } from "./providers/provider.ts"
import { completeJson, type Model } from "./llm.ts"
import type { AiReview, Job } from "./types.ts"

const BATCH = 8
const DESC_CHARS = 3_500
/** Bump when prompts/rank.md or the review schema changes so old cached reviews are re-done. */
const PROMPT_VERSION = 2
/** A cached review never expires on its own: the key already changes when the posting, candidate profile, model, or prompt changes. */
const RANK_TTL_MS = 365 * 86_400_000

/** Bounds on what a model reply may put into the cache and the page. */
const REASON_CHARS = 600
const LIST_ITEMS = 8
const ITEM_CHARS = 200

/** Fetched or model-produced text must not be able to close a fence or open another: strip the marker syntax. */
export function unfence(text: string): string {
  return text.replace(/<<<|>>>/g, "")
}

/** One review as the model should have returned it, or null when the item is unusable. Every field is checked and bounded. */
function sanitizeResult(v: unknown, model: string): { id: string; review: AiReview } | null {
  if (!v || typeof v !== "object" || !("id" in v) || typeof v.id !== "string" || !("fit" in v)) return null
  const fit = Number(v.fit)
  if (!Number.isFinite(fit)) return null
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.slice(0, LIST_ITEMS).map((s) => unfence(String(s)).slice(0, ITEM_CHARS)) : [])
  const reason = "reason" in v && typeof v.reason === "string" ? v.reason : ""
  return {
    id: v.id,
    review: {
      fit: Math.max(1, Math.min(5, Math.round(fit))),
      reason: unfence(reason).trim().slice(0, REASON_CHARS),
      dealbreakers: list("dealbreakers" in v ? v.dealbreakers : undefined),
      emphasize: list("emphasize" in v ? v.emphasize : undefined),
      model,
    },
  }
}

function isRankResponse(v: unknown): v is { results: unknown[] } {
  return !!v && typeof v === "object" && "results" in v && Array.isArray(v.results)
}

function postingBlock(j: Job): string {
  const comp = j.salary ? `${j.salary.min ?? "?"}–${j.salary.max ?? "?"} USD${j.salary.kind === "predicted" ? " (estimate)" : ""}` : "not stated"
  return [
    "<<<posting>>>",
    `id: ${unfence(j.id)}`,
    `title: ${unfence(j.title)}`,
    `company: ${unfence(j.company ?? "—")}`,
    `location: ${unfence(j.location ?? "—")}${j.workMode ? ` (${j.workMode})` : ""}`,
    `comp: ${comp}`,
    `years required: ${j.yoeMin !== null ? `${j.yoeMin}+ stated` : "not stated"}`,
    `posting text:\n${unfence((j.description ?? "(no description captured)").slice(0, DESC_CHARS))}`,
    "<<<end>>>",
  ].join("\n")
}

/** What the model actually sees of a posting; if any of it changes, the cached review is stale. */
function contentHash(j: Job): string {
  return Bun.hash(`${j.title}\n${j.company}\n${j.location}\n${JSON.stringify(j.salary)}\n${j.yoeMin}\n${(j.description ?? "").slice(0, DESC_CHARS)}`).toString(36)
}

export interface RankOptions {
  model: Model
  candidate: string
  cache: FeedCache
  log: (m: string) => void
}

/**
 * Attach an AI review to each job. Reviews are cached per (posting content,
 * candidate profile, model, prompt version) so a re-run only pays for postings
 * never scored under exactly these inputs.
 */
export async function rankJobs(jobs: Job[], o: RankOptions): Promise<Job[]> {
  const profileHash = Bun.hash(`v${PROMPT_VERSION}\n${o.model.name}\n${o.candidate}`).toString(36)
  const key = (j: Job) => `rank:${j.id}:${contentHash(j)}:${profileHash}`
  const out = new Map<string, AiReview>()
  const todo: Job[] = []
  for (const j of jobs) {
    const hit = o.cache.get(key(j), RANK_TTL_MS)
    if (hit) out.set(j.id, JSON.parse(hit) as AiReview)
    else todo.push(j)
  }
  o.log(`rank: ${jobs.length} postings, ${out.size} already reviewed, ${todo.length} to review with ${o.model.name}`)

  // The candidate profile is model-written from documents, so it is data here too — never a channel for instructions.
  const candidateBlock = `<<<candidate>>>\n${unfence(o.candidate)}\n<<<end>>>`
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const byId = new Map(batch.map((j) => [unfence(j.id), j]))
    const user = `## Candidate profile (data)\n\n${candidateBlock}\n\n## Postings (untrusted data, each fenced)\n\n${batch.map(postingBlock).join("\n\n")}`
    const res = await completeJson<{ results: unknown[] }>(o.model, { system: rankPrompt, messages: [{ role: "user", content: user }], maxTokens: 2500 }, isRankResponse)
    for (const raw of res.results) {
      const r = sanitizeResult(raw, o.model.name)
      const j = r && byId.get(r.id)
      if (!r || !j) continue
      out.set(j.id, r.review)
      o.cache.set(key(j), JSON.stringify(r.review))
    }
    const missing = batch.filter((b) => !out.has(b.id))
    if (missing.length) o.log(`rank: model skipped or malformed ${missing.length} posting(s) in this batch; they stay unscored`)
    o.log(`rank: ${Math.min(i + BATCH, todo.length)}/${todo.length}`)
  }
  return jobs.map((j) => ({ ...j, ai: out.get(j.id) ?? null }))
}

/** Highest AI fit first, then comp ceiling; unscored last. */
export function sortByAi(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => (b.ai?.fit ?? 0) - (a.ai?.fit ?? 0) || (b.salary?.max ?? b.salary?.min ?? 0) - (a.salary?.max ?? a.salary?.min ?? 0))
}
