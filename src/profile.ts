import { existsSync, readFileSync } from "node:fs"
import { ENV_PATH, PROFILE_PATH } from "./paths.ts"
import { ALL_SOURCES, LEVELS, PRESETS, DEFAULT_PRESET, type Level, type Preset, type SearchParams, type Source } from "./types.ts"

/** Standing search preferences, so `search`/`digest`/`ui` run with no flags. Written by `jobsweep init`. */
export interface Profile {
  cities: string[]
  /** Role preset the defaults come from; every field below may override it. */
  preset: Preset
  /** Keyword searches for server-side sources. */
  queries: string[]
  /** Title gate applied to every result. */
  titleRe: RegExp
  minTc: number | null
  maxYoe: number | null
  levels: Level[] | null
  remote: SearchParams["remote"]
  days: number | null
  sources: Source[]
  /** Skills to score postings against (word match on title + description). */
  skills: string[]
  /** Title words that disqualify a posting outright. */
  exclude: string[]
  /** The user read the LinkedIn terms notice and chose to run that connector locally. */
  linkedinAccepted: boolean
}

export const LINKEDIN_NOTICE =
  "LinkedIn has no public job API. This connector reads LinkedIn's public guest job pages from your machine, which LinkedIn's terms prohibit doing automatically. " +
  "It is off by default. Turn it on only for your own personal search, at low volume, on your own responsibility — never from a shared server."

/**
 * Load the config-dir `.env` (then `./.env`) into process.env without overriding
 * variables already set. Secrets stay out of the profile and the repo.
 */
export function loadEnv(): void {
  for (const path of [ENV_PATH(), `${process.cwd()}/.env`]) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
      if (!m || line.trim().startsWith("#")) continue
      const [, key, rawVal] = m
      const val = rawVal!.replace(/^(['"])(.*)\1$/, "$2")
      if (process.env[key!] === undefined) process.env[key!] = val
    }
  }
}

export function parseMoney(raw: string): number | null {
  const m = /^\$?\s*(\d+(?:\.\d+)?)\s*([kK])?$/.exec(String(raw).replace(/,/g, ""))
  return m ? Math.round(parseFloat(m[1]!) * (m[2] ? 1000 : 1)) : null
}

function bad(msg: string): never {
  throw new Error(`profile.json: ${msg}`)
}

const PROFILE_KEYS: Record<string, true> = {
  cities: true, preset: true, queries: true, query: true, titlePattern: true, minTc: true, maxYoe: true, levels: true, remote: true, days: true, sources: true, skills: true, exclude: true, linkedinAccepted: true,
}

function strings(raw: unknown, key: string): string[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw) || !raw.length || !raw.every((s) => typeof s === "string" && s.trim())) bad(`"${key}" must be a non-empty array of strings`)
  return raw.map((s) => s.trim())
}

export function parseProfile(raw: Record<string, unknown>): Profile {
  // An unknown key is a typo that would otherwise silently fall back to a default — refuse it.
  for (const k of Object.keys(raw)) if (!PROFILE_KEYS[k]) bad(`unknown key "${k}" (known: ${Object.keys(PROFILE_KEYS).join(", ")})`)
  const cities = strings(raw.cities, "cities")
  if (!cities) bad(`"cities" must be a non-empty array`)

  const presetName = raw.preset == null ? DEFAULT_PRESET.name : String(raw.preset)
  const preset = PRESETS[presetName]
  if (!preset) bad(`preset must be one of ${Object.keys(PRESETS).join(", ")}`)

  if (raw.query != null && raw.queries != null) bad(`set "queries" (array) or "query" (single string), not both`)
  if (raw.query != null && (typeof raw.query !== "string" || !raw.query.trim())) bad(`"query" must be a non-empty string`)
  const queries = strings(raw.queries, "queries") ?? (raw.query != null ? [String(raw.query).trim()] : preset.queries)

  const levels = raw.levels == null ? null : (strings(raw.levels, "levels") as Level[])
  for (const l of levels ?? []) if (!LEVELS.includes(l)) bad(`levels must be in ${LEVELS.join(",")}`)
  const sources = raw.sources == null ? ALL_SOURCES.filter((s) => s !== "linkedin") : (strings(raw.sources, "sources") as Source[])
  for (const s of sources) if (!ALL_SOURCES.includes(s)) bad(`sources must be in ${ALL_SOURCES.join(",")}`)
  const remote = raw.remote == null ? "include" : String(raw.remote)
  if (!["include", "only", "exclude"].includes(remote)) bad(`remote must be include|only|exclude`)
  const minTc = raw.minTc == null ? null : parseMoney(String(raw.minTc))
  if (raw.minTc != null && minTc === null) bad(`minTc must look like 180000 or "180k"`)
  for (const k of ["maxYoe", "days"]) if (raw[k] != null && (!Number.isInteger(Number(raw[k])) || Number(raw[k]) < 0)) bad(`"${k}" must be a non-negative integer`)

  let titleRe = new RegExp(preset.titlePattern, "i")
  if (raw.titlePattern != null) {
    try {
      titleRe = new RegExp(String(raw.titlePattern), "i")
    } catch (e) {
      bad(`titlePattern is not a valid regex: ${e instanceof Error ? e.message : e}`)
    }
  }
  return {
    cities,
    preset,
    queries,
    titleRe,
    minTc,
    maxYoe: raw.maxYoe == null ? null : Number(raw.maxYoe),
    levels,
    remote: remote as SearchParams["remote"],
    days: raw.days == null ? null : Number(raw.days),
    sources,
    skills: strings(raw.skills, "skills") ?? preset.skills,
    exclude: raw.exclude == null ? preset.exclude : (strings(raw.exclude, "exclude") ?? []),
    linkedinAccepted: raw.linkedinAccepted === true,
  }
}

export async function loadProfile(path = PROFILE_PATH()): Promise<Profile | null> {
  const f = Bun.file(path)
  if (!(await f.exists())) return null
  return parseProfile((await f.json()) as Record<string, unknown>)
}
