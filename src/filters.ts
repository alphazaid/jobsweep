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

const REMOTE = /\bremote\b|work from home|\bwfh\b|\banywhere\b/i
const US = /\bUS(?:A)?\b|\bU\.S\.(?:A\.)?/
const US_COUNTRY = /\bunited states(?: of america)?\b/i
const US_LOCATION = /^(?:the\s+)?us(?:a)?(?:\b|$)|\bremote[\s:(,-]+us(?:a)?\b/i
const GLOBAL_REMOTE = /\b(?:worldwide|world wide|global(?:ly)?|anywhere in the world|work from anywhere|no location restrictions)\b/i
const BARE_REMOTE = /^(?:remote|fully remote|remote first|work from home|wfh|anywhere|distributed)(?:[\s(),:/-]*)$/i
const STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas",
  KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan",
  MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada",
  NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina",
  ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania",
  RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas",
  UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia",
  WI: "wisconsin", WY: "wyoming",
}
const METRO_STATES: Record<string, string[]> = {
  "new york": ["NY", "NJ"], "san francisco": ["CA"], dallas: ["TX"], seattle: ["WA"],
  austin: ["TX"], chicago: ["IL"], boston: ["MA"], "los angeles": ["CA"], denver: ["CO"],
  washington: ["DC", "VA", "MD"], atlanta: ["GA"], miami: ["FL"], philadelphia: ["PA"],
}
const US_METROS = Object.keys(METRO_STATES)
const STATE_BY_NAME: Record<string, string> = Object.fromEntries(Object.entries(STATE_NAMES).map(([code, name]) => [name, code]))
interface LocationMatcher {
  aliases: RegExp[]
  states: string[]
  country: "us" | "canada" | "uk"
}
const STATE_CODES = Object.keys(STATE_NAMES).join("|")
const STATE_WORDS = Object.values(STATE_NAMES).join("|")
const QUALIFIED_STATE = new RegExp(`^\\s*,?\\s*(${STATE_CODES}|${STATE_WORDS})\\b`, "i")
const US_STATE_LOCATION = new RegExp(`,\\s*(?:${STATE_CODES}|${STATE_WORDS})\\b`, "i")
const US_STATE_SUFFIX = new RegExp(`\\s+(?:${STATE_CODES})(?=$|[,;/|()]|\\s+(?:or\\s+remote|United\\s+States))`)
const STATE_ONLY = new RegExp(`^(?:remote[\\s\\u2010-\\u2015(),:/-]+)?(${STATE_CODES}|${STATE_WORDS})(?:\\s*\\(?remote\\)?)?$`, "i")
const STATE_MENTIONS = new RegExp(`\\b(?:${STATE_WORDS})\\b|\\b(?:${STATE_CODES})\\b`, "gi")
const LOCAL_MATCHERS = new Map<string, LocationMatcher>()
const RESIDENCE = /\b(?:(?:candidates?|applicants?|you|employees?)\s+(?:(?:must|need to|have to|should already)\s+(?:be\s+)?|(?:are\s+)?required to\s+(?:be\s+)?)|must\s+(?:be\s+)?)(?:based|located|residing|reside|live|living)\s+(?:in|within)\s+(.{1,180})/i
const HIRING_AREA = /\b(?:only\s+(?:hiring|hire|accepting applicants)\s+(?:in|from)|(?:role|position|job)\s+is\s+(?:only\s+)?open\s+to\s+(?:candidates?|applicants?|residents?)\s+(?:based\s+|located\s+|living\s+)?(?:in|of))\s+(.{1,180})/i
const HIRING_EXCLUSION = /\b(?:not eligible to be hired in|(?:cannot|can't|do not|don't|unable to|not able to)\s+(?:currently\s+)?hire\s+(?:(?:candidates?|applicants?|residents?)\s+(?:based\s+|living\s+|residing\s+)?(?:in|of|from)|in|from)|(?:excluding|except(?: for)?|not available in|not open to residents of))\s+(.{1,180})/i
const OFFICE_MODE = /\b(?:on[ -]?site|in[ -]?office|hybrid|in[ -]?person)\b/i
const OPTIONAL_OFFICE = /\b(?:not required|no requirement|do not require|does not require|don't require|isn't required|optional|not mandatory|no mandatory)\b/i
const REMOTE_OFFICE_EXCEPTION = /\b(?:except(?: for)?|(?:does|do) not apply to)\s+(?:fully\s+)?remote\s+(?:roles|positions|jobs)\b/i
const OFFICE_DIRECT = /\b(?:on[ -]?site|in[ -]?office)\s+(?:in|at)\s+(?:our\s+|the\s+)?(.{1,160})/i
const OFFICE_BASE = /\b(?:role|position|job)\b.{0,60}\b(?:based(?: out of)?|located)\s+(?:in|at|out of)\s+(?:the\s+|our\s+)?(.{1,160})/i
const OFFICE_REQUIRED = /\b(?:must|required|requires?|expected|expectation|mandatory)\b/i
const OFFICE_ROLE_MODE = /\b(?:hybrid|on[ -]?site)(?:[ -]remote)?\s+(?:role|position|job)\b|\b(?:role|position|job)\s+(?:is|will be)\s+(?:an?\s+)?(?:hybrid|on[ -]?site)\b/i
const OFFICE_PLACE = /\b(?:at|in|from)\s+(?:our\s+|the\s+)?(?!office\b|headquarters\b|person\b|be\b)(.{1,100}?)\s+(?:office|headquarters)\b/i
const TEMPORARY_ATTENDANCE = /\b(?:onboarding|orientation|interviews?|technicals)\b/i
const TRAVEL = /\b(?:travel|visits?|off[ -]sites?)\b/i
const WEEKLY = /\b(?:weekly|(?:each|every|per|a)\s+week)\b/i
const REMOTE_ROLE = /\b(?:this|the)\s+(?:role|position|job)\b.{0,80}\bremote\b|\bremote\s+(?:in|within|throughout|across|from|[-:(])|\bcandidates?\s+can\s+be\s+located\b/i

function stateCode(value: string): string | undefined {
  const upper = value.toUpperCase()
  if (STATE_NAMES[upper]) return upper
  return STATE_BY_NAME[value.toLowerCase()]
}

function locationMatcher(city: string): LocationMatcher {
  let matcher = LOCAL_MATCHERS.get(city)
  if (matcher) return matcher
  const key = city.split(",")[0]!.trim().toLowerCase()
  const explicitState = city.includes(",") ? stateCode(city.split(",")[1]!.trim()) : undefined
  matcher = {
    aliases: cityTerms(city).map((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi")),
    states: METRO_STATES[key] ?? (explicitState ? [explicitState] : []),
    country: key === "toronto" || /\bcanada\b/i.test(city) ? "canada"
      : key === "london" || /\b(?:uk|united kingdom)\b/i.test(city) ? "uk" : "us",
  }
  LOCAL_MATCHERS.set(city, matcher)
  return matcher
}

function inMetro(text: string, matcher: LocationMatcher): boolean {
  for (const alias of matcher.aliases) {
    alias.lastIndex = 0
    for (const hit of text.matchAll(alias)) {
      const suffix = text.slice(hit.index + hit[0].length).split(/[;/|]|\s+(?:or|and)\s+/i)[0]!
      // Qualifiers belong to this alternative, not another city's country.
      if (matcher.country !== "canada" && /\bcanada\b/i.test(suffix)) continue
      if (matcher.country !== "uk" && /\b(?:uk|united kingdom)\b/i.test(suffix)) continue
      if (matcher.country !== "us" && (US.test(suffix) || US_COUNTRY.test(suffix))) continue
      const qualifier = QUALIFIED_STATE.exec(suffix)
      const state = qualifier?.[1]
      if (!state || (state.length === 2 && state !== state.toUpperCase())
        || !matcher.states.length || matcher.states.includes(stateCode(state)!)) return true
    }
  }
  return false
}

/** Positive geography, never "not on a list of foreign places". Alternatives may include other countries. */
function compatibleGeography(text: string, matcher: LocationMatcher): boolean {
  if (GLOBAL_REMOTE.test(text) || inMetro(text, matcher)) return true
  if (matcher.country === "canada") return /\bcanada\b/i.test(text)
  if (matcher.country === "uk") return /\b(?:uk|united kingdom)\b/i.test(text)
  return US.test(text) || US_COUNTRY.test(text) || US_LOCATION.test(text.trim())
}

function remoteGeography(text: string, matcher: LocationMatcher): boolean {
  if (compatibleGeography(text, matcher) || BARE_REMOTE.test(text.trim())
    || (matcher.country === "us" && /,\s*us(?:a)?\s*$/i.test(text))) return true
  if (/\s+or\s+|[|;]/i.test(text) && text.split(/\s+or\s+|[|;]/i).some((part) => BARE_REMOTE.test(part.trim()))) return true
  if (matcher.country !== "us") return false
  if (mentionsSearchRegion(text, matcher)) return true
  // A regional remote label is not nationwide. Non-remote location metadata
  // may instead name the US headquarters of a remote-tagged role.
  if (REMOTE.test(text)) return false
  if (US_STATE_LOCATION.test(text) || US_STATE_SUFFIX.test(text) || STATE_ONLY.test(text.trim())) return true
  for (const metro of US_METROS) if (inMetro(text, locationMatcher(metro))) return true
  return false
}

function mentionsSearchRegion(text: string, matcher: LocationMatcher): boolean {
  // Uppercase abbreviations only: prose "in", "or", and "me" are not states.
  STATE_MENTIONS.lastIndex = 0
  for (const match of text.matchAll(STATE_MENTIONS)) {
    if (match[0].length === 2 && match[0] !== match[0].toUpperCase()) continue
    const state = stateCode(match[0])
    if (state && matcher.states[0] === state) return true
  }
  return inMetro(text, matcher)
}

function locationExcluded(location: string, matcher: LocationMatcher): boolean {
  const exclusion = HIRING_EXCLUSION.exec(location)
  return exclusion !== null && mentionsSearchRegion(exclusion[1]!, matcher)
}

/** Only explicit role/candidate requirements count; company addresses and compensation geography do not. */
function descriptionLocation(description: string | null, matcher: LocationMatcher, taggedRemote: boolean) {
  let office: string | null = null
  let remote: string | null = null
  let onsite = false
  if (!description) return { blocked: false, office, remote, onsite }
  const text = description.replace(/[\u2010-\u2015]/g, "-").replace(/[*_]/g, "")
    .replace(/\bU\.S\.(?:A\.)?/gi, "US").replace(/\bD\.C\./g, "DC")
  const remoteOfficeExempt = taggedRemote && REMOTE_OFFICE_EXCEPTION.test(text)
  for (const part of text.split(/[.!?\n]+/)) {
    const sentence = part.trim()
    const exclusion = /\b(?:salary|compensation|pay range)\b/i.test(sentence) ? null : HIRING_EXCLUSION.exec(sentence)
    if (exclusion && mentionsSearchRegion(exclusion[1]!, matcher)) return { blocked: true, office, remote, onsite }
    const residence = RESIDENCE.exec(sentence) ?? HIRING_AREA.exec(sentence)
    if (residence) {
      const geography = residence[1]!.split(/\s+(?:to work|with|where|who|but|and must)\b/i)[0]!
      if (!compatibleGeography(geography, matcher)) return { blocked: true, office, remote, onsite }
    }
    if (REMOTE.test(sentence) && REMOTE_ROLE.test(sentence) && compatibleGeography(sentence, matcher)) remote = sentence
    if (!OFFICE_MODE.test(sentence) || OPTIONAL_OFFICE.test(sentence)
      || (taggedRemote && REMOTE_OFFICE_EXCEPTION.test(sentence))
      || TEMPORARY_ATTENDANCE.test(sentence) || (TRAVEL.test(sentence) && !WEEKLY.test(sentence))) continue
    const required = OFFICE_DIRECT.exec(sentence)
      ?? (OFFICE_REQUIRED.test(sentence) || OFFICE_ROLE_MODE.test(sentence) ? OFFICE_BASE.exec(sentence) : null)
      ?? (OFFICE_REQUIRED.test(sentence) ? OFFICE_PLACE.exec(sentence) : null)
    if (required) {
      const geography = required[1]!.split(/\bwith the expectation\b/i)[0]!.trim()
      // An unnamed office is not a foreign place; fall back to the posting's local location.
      if (!/^(?:office|headquarters|be|person|an?\b)/i.test(geography)) {
        if (!inMetro(geography, matcher)) return { blocked: true, office, remote, onsite }
        office = geography
        onsite = true
      } else if (!remoteOfficeExempt) onsite = true
    } else if (OFFICE_ROLE_MODE.test(sentence)
      || (!remoteOfficeExempt && OFFICE_REQUIRED.test(sentence) && /\b(?:you|employees|candidates|applicants)\b/i.test(sentence))) {
      onsite = true
    }
  }
  return { blocked: false, office, remote, onsite }
}

/** True when the built-in or user metro table knows this city (so suburbs and nicknames will match). */
export function knownMetro(city: string): boolean {
  return city.split(",")[0]!.trim().toLowerCase() in METRO
}

export function cityTerms(city: string): string[] {
  const key = city.split(",")[0]!.trim().toLowerCase()
  return METRO[key] ?? [key]
}

/**
 * The posting location that satisfies the search. Explicit candidate/attendance
 * restrictions override metadata; remote locations need compatible geography.
 */
export function matchedLocation(job: Job, p: SearchParams): string | null {
  const matcher = locationMatcher(p.city)
  const locs = job.locations.length ? job.locations : job.location ? [job.location] : []
  const taggedRemote = job.workMode === "remote" || locs.some((location) => REMOTE.test(location))
  const restriction = descriptionLocation(job.description, matcher, taggedRemote)
  if (restriction.blocked) return null
  const inCity = locs.find((location) => !locationExcluded(location, matcher) && inMetro(location, matcher))
  if (restriction.onsite) return p.remote === "only" ? null : inCity ?? restriction.office
  if (p.remote === "exclude") return inCity && job.workMode !== "remote" && !REMOTE.test(inCity) ? inCity : null
  if (p.remote === "include" && inCity) return inCity
  const remoteLoc = locs.find((location) => !locationExcluded(location, matcher)
    && (REMOTE.test(location) || job.workMode === "remote") && remoteGeography(location, matcher))
  if (remoteLoc) return remoteLoc
  if (restriction.remote) return "Remote"
  if (job.workMode === "remote" && !locs.length) return "Remote"
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
