import { existsSync, readFileSync, writeFileSync } from "node:fs"
import candidatePrompt from "../prompts/candidate.md" with { type: "text" }
import interviewPrompt from "../prompts/interview.md" with { type: "text" }
import { fileSource, hasLifeos, lifeosSources, type ContextSource } from "./context.ts"
import { completeJson, type Message, type Model } from "./llm.ts"
import { CANDIDATE_PATH, PROFILE_PATH } from "./paths.ts"

const out = (s = "") => process.stdout.write(s + "\n")

function ask(q: string, def?: string): string {
  const a = prompt(def === undefined ? `${q}: ` : `${q} [${def}]: `)
  return (a ?? "").trim() || def || ""
}

function yes(q: string, def = true): boolean {
  return ask(`${q} (${def ? "Y/n" : "y/N"})`, def ? "y" : "n").toLowerCase().startsWith("y")
}

interface Turn {
  ask?: string
  done?: boolean
}

export interface ProfileSuggestion {
  cities?: string[]
  remote?: "include" | "only" | "exclude"
  minTc?: number | null
  maxYoe?: number | null
  skills?: string[]
  exclude?: string[]
  queries?: string[]
}

interface CandidateResult {
  candidate: string
  profile: ProfileSuggestion
  unknowns: string[]
}

function isCandidateResult(v: unknown): v is CandidateResult {
  return !!v && typeof v === "object" && typeof (v as CandidateResult).candidate === "string" && typeof (v as CandidateResult).profile === "object"
}

function contextBlock(sources: ContextSource[]): string {
  return sources.map((s) => `### ${s.label}\n${s.text}`).join("\n\n") || "(no documents provided)"
}

export interface InterviewOptions {
  model: Model
  resume?: string
  notes?: string[]
  /** Use LifeOS files when an install is present (default: ask). */
  lifeos?: boolean
  maxQuestions?: number
}

/**
 * Build `candidate.md` and suggest profile.json values. Everything pulled from
 * files is shown and confirmed before use; every profile change is confirmed
 * field by field before it is written.
 */
export async function interview(o: InterviewOptions): Promise<number> {
  const sources: ContextSource[] = []
  if (o.resume) sources.push(await fileSource(o.resume))
  for (const n of o.notes ?? []) sources.push(await fileSource(n, "notes"))
  if (hasLifeos() && o.lifeos !== false) {
    const found = lifeosSources()
    if (found.length) {
      out("Found a LifeOS install with these files about you:")
      for (const s of found) out(`  - ${s.label}: ${s.path} (${s.text.length} chars)`)
      if (o.lifeos === true || yes("Use them as interview context?")) sources.push(...found)
    }
  }
  if (!sources.length) out("No resume or context files — I'll ask more questions instead. (Pass --resume <file> to start from your resume.)")
  else out(`\nUsing ${sources.length} source${sources.length === 1 ? "" : "s"}: ${sources.map((s) => s.label).join(", ")}`)
  out(`Model: ${o.model.name}. Answer briefly; type "done" to stop early.\n`)

  const context = contextBlock(sources)
  const transcript: Message[] = [{ role: "user", content: `Context documents:\n\n${context}\n\nBegin the interview.` }]
  const max = o.maxQuestions ?? 8
  for (let i = 0; i < max; i++) {
    const turn = await completeJson<Turn>(o.model, { system: interviewPrompt, messages: transcript, maxTokens: 300 })
    if (turn.done || !turn.ask) break
    transcript.push({ role: "assistant", content: JSON.stringify(turn) })
    const answer = ask(`\n${turn.ask}\n>`)
    if (answer.toLowerCase() === "done") break
    transcript.push({ role: "user", content: answer })
  }

  // Nothing the model wrote about the person is saved until they accept it.
  const extra: Message[] = [{ role: "user", content: "Now produce the candidate profile JSON." }]
  for (;;) {
    out("\nDrafting your profile…")
    const result = await completeJson<CandidateResult>(o.model, { system: candidatePrompt, messages: [...transcript, ...extra], maxTokens: 2500 }, isCandidateResult)
    out(`\n${result.candidate.trim()}\n`)
    if (result.unknowns?.length) out(`Still unknown: ${result.unknowns.join("; ")}\n`)
    const choice = ask("Accept this profile? (y = save, c = correct something, r = redo)", "y").toLowerCase()
    if (choice.startsWith("y")) {
      writeFileSync(CANDIDATE_PATH(), result.candidate.trim() + "\n")
      out(`Saved to ${CANDIDATE_PATH()}`)
      await applySuggestions(result.profile)
      return 0
    }
    if (choice.startsWith("c")) {
      const fix = ask("What's wrong or missing?\n>")
      if (fix) {
        extra.push({ role: "assistant", content: JSON.stringify(result) }, { role: "user", content: `Correction from the candidate: ${fix}\nProduce the corrected candidate profile JSON.` })
        continue
      }
    }
    if (choice.startsWith("r")) {
      extra.push({ role: "assistant", content: JSON.stringify(result) }, { role: "user", content: "Redo the profile from scratch, more carefully. Produce the candidate profile JSON." })
      continue
    }
    out("Nothing saved.")
    return 1
  }
}

/** Show each suggested profile value against the current one and write only what the user accepts. */
async function applySuggestions(s: ProfileSuggestion): Promise<void> {
  const path = PROFILE_PATH()
  const current: Record<string, unknown> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
  const changes: Array<[string, unknown]> = []
  const fmt = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v == null ? "—" : String(v))
  for (const key of ["cities", "remote", "minTc", "maxYoe", "skills", "exclude", "queries"] as const) {
    const next = s[key]
    if (next === undefined) continue
    if (JSON.stringify(next) === JSON.stringify(current[key])) continue
    if (yes(`profile.${key}: ${fmt(current[key])} → ${fmt(next)}. Apply?`)) changes.push([key, next])
  }
  if (!changes.length) {
    out("profile.json unchanged.")
    return
  }
  for (const [k, v] of changes) current[k] = v
  if (!current.cities) current.cities = s.cities ?? []
  writeFileSync(path, JSON.stringify(current, null, 2) + "\n")
  out(`Updated ${changes.map(([k]) => k).join(", ")} in ${path}. Run \`jobsweep search\` then \`jobsweep rank\`.`)
}
