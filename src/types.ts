import swePreset from "../presets/swe.json"

export type Source = "linkedin" | "greenhouse" | "lever" | "ashby" | "adzuna" | "freehire"

export const ALL_SOURCES: Source[] = ["linkedin", "greenhouse", "lever", "ashby", "adzuna", "freehire"]

export type WorkMode = "remote" | "hybrid" | "onsite"

/** Title-derived seniority band. Used when a posting states no years requirement. */
export type Level = "intern" | "entry" | "mid" | "senior" | "staff"

export const LEVELS: Level[] = ["intern", "entry", "mid", "senior", "staff"]

export interface Salary {
  /** Annualized USD. */
  min: number | null
  max: number | null
  /** Verbatim text the numbers came from. */
  raw: string
  /** structured = the ATS exposed numbers; parsed = regex over the description; predicted = aggregator estimate. */
  kind: "structured" | "parsed" | "predicted"
}

export interface Job {
  /** `${source}:${sourceId}` — stable across runs. */
  id: string
  source: Source
  sourceId: string
  title: string
  company: string | null
  /** Location shown for the posting. Sources set their primary; after filtering it is the one that matched the search. */
  location: string | null
  /** Every location the posting is open in (primary + secondary). Used for city matching. */
  locations: string[]
  workMode: WorkMode | null
  url: string
  /** ISO-8601 date the posting went live, or null when the source does not say. */
  postedAt: string | null
  salary: Salary | null
  /** Smallest years-of-experience the posting requires, parsed from its text. */
  yoeMin: number | null
  level: Level
  /** Plain text description. Null when the source's search surface omits it and detail was not fetched. */
  description: string | null
  /** Profile skills found in the posting text; null when no profile skills are configured. */
  fit: { matched: string[]; total: number } | null
  /** Model review from `jobsweep rank`; null until ranked. */
  ai: AiReview | null
}

/** What a model concluded about one posting for one candidate. */
export interface AiReview {
  /** 1 skip … 5 apply today. */
  fit: number
  reason: string
  dealbreakers: string[]
  emphasize: string[]
  model: string
}

export interface SearchParams {
  /** Keyword queries run against each server-side source (LinkedIn, Adzuna, freehire); results are unioned. */
  queries: string[]
  /** Every result's title must match this, whichever source it came from. Board feeds have no other query. */
  titleRe: RegExp
  city: string
  remote: "include" | "only" | "exclude"
  /** Annual USD floor applied to salary.max (the top of the posted band). */
  minTc: number | null
  maxYoe: number | null
  levels: Level[] | null
  days: number | null
  sources: Source[]
  /** Result cap per query per source, before filtering. */
  perSource: number
  /** Fetch LinkedIn detail pages so descriptions (and thus comp/YOE) are available. */
  hydrate: boolean
  /** The user explicitly enabled the LinkedIn connector after reading its terms notice. */
  linkedinAccepted: boolean
}

/** A role preset: the title gate, default queries, skills to score, and title words to exclude. Bundled from presets/*.json. */
export interface Preset {
  name: string
  description: string
  titlePattern: string
  queries: string[]
  skills: string[]
  exclude: string[]
}

export const PRESETS: Record<string, Preset> = { swe: swePreset }
export const DEFAULT_PRESET = PRESETS.swe!

/** Default title gate (SWE preset): requires a software role noun, rejects adjacent disciplines that share "engineer". */
export const SWE_TITLE_RE = new RegExp(DEFAULT_PRESET.titlePattern, "i")
/** Default keyword queries for server-side sources. Each is a separate search; the union is deduped. */
export const DEFAULT_QUERIES = DEFAULT_PRESET.queries

/** Staffing agencies and job aggregators posing as employers. Their postings duplicate real ones and hide the company. */
export const AGENCY_RE =
  /\b(recruit|recruiting|recruitment|staffing|talent|jobgether|kforce|kelly services|robert half|teksystems|tek systems|russell,? tobin|motion recruitment|insight global|apex systems|cybercoders|jobot|harnham|hays|randstad|adecco|modis|mondo|dice|hire ?quest|first soft solutions|consulting solutions|underdog\.io)\b/i

export interface Company {
  name: string
  ats: "greenhouse" | "lever" | "ashby"
  slug: string
}

export class ProviderError extends Error {
  constructor(
    public readonly source: Source,
    message: string,
  ) {
    super(message)
  }
}

/** One completed search, for history charts. */
export interface RunSummary {
  ts: number
  cities: string[]
  total: number
  withComp: number
  newCount: number
  carried: number
}

export type DecisionStatus = "apply" | "maybe" | "skip" | "applied"
export const DECISION_STATUSES: DecisionStatus[] = ["apply", "maybe", "skip", "applied"]

/** A user's mark on a posting; kept server-side by `jobsweep serve` and exportable. */
export interface Decision {
  status: DecisionStatus | ""
  note: string
  updatedAt: number
}
