import { existsSync, readFileSync } from "node:fs"
import metrosJson from "./metros.json"
import { USER_METROS_PATH } from "./paths.ts"
import type { Job, Level, SearchParams } from "./types.ts"

/**
 * Metro aliases so "New York" matches "NYC", "Brooklyn", "Manhattan". Built-in table
 * (src/metros.json) merged with the user's `metros.json` in the config dir, which wins per key.
 */
function loadMetros(): Record<string, string[]> {
  const base: Record<string, string[]> = { ...metrosJson }
  const userPath = USER_METROS_PATH()
  if (existsSync(userPath)) {
    const user = JSON.parse(readFileSync(userPath, "utf8")) as Record<string, string[]>
    for (const [k, v] of Object.entries(user)) base[k.toLowerCase()] = v.map((s) => s.toLowerCase())
  }
  return base
}
const METRO = loadMetros()

const FOREIGN = /\b(canada|uk|united kingdom|emea|europe|india|apac|latam|brazil|germany|poland|ireland|mexico|australia|singapore|japan|toronto|london|berlin|bangalore|bengaluru)\b/i
const REMOTE = /\bremote\b|work from home|\bwfh\b|\banywhere\b/i

/** True when the built-in or user metro table knows this city (so suburbs and nicknames will match). */
export function knownMetro(city: string): boolean {
  return city.split(",")[0]!.trim().toLowerCase() in METRO
}

export function cityTerms(city: string): string[] {
  const key = city.split(",")[0]!.trim().toLowerCase()
  return METRO[key] ?? [key]
}

/**
 * The posting location that satisfies the search — a metro alias hit, or (when
 * remote is "include"/"only") a US remote location — or null when none does.
 */
export function matchedLocation(job: Job, p: SearchParams): string | null {
  const terms = cityTerms(p.city)
  const locs = job.locations.length ? job.locations : job.location ? [job.location] : []
  const inCity = locs.find((l) => {
    const s = l.toLowerCase()
    return terms.some((t) => s.includes(t))
  })
  if (p.remote === "exclude") return inCity && job.workMode !== "remote" ? inCity : null
  if (p.remote === "include" && inCity) return inCity
  const remoteLoc = locs.find((l) => REMOTE.test(l) && !FOREIGN.test(l))
  if (remoteLoc) return remoteLoc
  // Source flagged it remote without saying so in the location text (freehire work_mode, Ashby isRemote).
  if (job.workMode === "remote" && !locs.some((l) => FOREIGN.test(l))) return locs[0] ?? "Remote"
  return null
}

/** A posting passes the TC floor when its band ceiling clears it. Unknown comp passes (flagged downstream). */
export function meetsTc(job: Job, minTc: number | null): boolean {
  if (minTc === null || !job.salary) return true
  const ceiling = job.salary.max ?? job.salary.min
  return ceiling === null || ceiling >= minTc
}

/** Title-band floor used when a posting states no years requirement. */
const LEVEL_FLOOR: Record<Level, number> = { intern: 0, entry: 0, mid: 2, senior: 5, staff: 8 }

export function meetsExperience(job: Job, p: SearchParams): boolean {
  if (p.levels && !p.levels.includes(job.level)) return false
  if (p.maxYoe === null) return true
  if (job.yoeMin !== null) return job.yoeMin <= p.maxYoe
  return LEVEL_FLOOR[job.level] <= p.maxYoe
}

export interface FilterResult {
  kept: Job[]
  dropped: Record<"city" | "tc" | "experience", number>
}

export function applyFilters(jobs: Job[], p: SearchParams): FilterResult {
  const dropped = { city: 0, tc: 0, experience: 0 }
  const kept: Job[] = []
  for (const j of jobs) {
    const loc = matchedLocation(j, p)
    if (loc === null) dropped.city++
    else if (!meetsTc(j, p.minTc)) dropped.tc++
    else if (!meetsExperience(j, p)) dropped.experience++
    else kept.push({ ...j, location: loc })
  }
  return { kept, dropped }
}

// ---------------------------------------------------------------------------
// Dedupe: the same posting shows up on LinkedIn, freehire, and the company's own
// board. Keep the copy with the best data (structured comp > parsed > none, then
// company board > aggregator).

const SOURCE_RANK: Record<Job["source"], number> = { ashby: 0, greenhouse: 1, lever: 2, adzuna: 3, freehire: 4, linkedin: 5 }

function norm(s: string | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|the)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

/** Metro name for a location ("New York City Metropolitan Area" → "new york"), else its first segment. */
export function metroOf(location: string | null): string {
  const s = (location ?? "").toLowerCase()
  if (/\bremote\b/.test(s)) return "remote"
  for (const [metro, aliases] of Object.entries(METRO)) if (aliases.some((a) => s.includes(a))) return metro
  return s.split(/[,;&]/)[0]?.trim() ?? ""
}

export function dedupeKey(job: Job): string {
  return `${norm(job.company)}|${norm(job.title)}|${metroOf(job.location)}`
}

function quality(job: Job): number {
  const comp = job.salary ? (job.salary.kind === "structured" ? 0 : job.salary.kind === "parsed" ? 1 : 2) : 3
  return comp * 10 + SOURCE_RANK[job.source]
}

const BOARD_SOURCES: Record<Job["source"], boolean> = { ashby: true, greenhouse: true, lever: true, adzuna: false, freehire: false, linkedin: false }

/**
 * Collapse the same posting seen through several sources. Within one metro the
 * best-data copy wins; and when the company's own board carries a title, every
 * aggregator copy of that title is dropped regardless of the location string —
 * aggregators mislabel locations (a Toronto-only posting tagged New York), the
 * board does not.
 */
export function dedupe(jobs: Job[]): Job[] {
  const best: Record<string, Job> = {}
  for (const j of jobs) {
    const k = dedupeKey(j)
    const cur = best[k]
    if (!cur || quality(j) < quality(cur)) best[k] = j
  }
  const onBoard: Record<string, true> = {}
  for (const j of Object.values(best)) if (BOARD_SOURCES[j.source]) onBoard[`${norm(j.company)}|${norm(j.title)}`] = true
  return Object.values(best).filter((j) => BOARD_SOURCES[j.source] || !onBoard[`${norm(j.company)}|${norm(j.title)}`])
}
