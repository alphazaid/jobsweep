import type { Level, Salary, WorkMode } from "./types.ts"

function codePoint(cp: number): string {
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** Strip markup into readable prose, keeping block boundaries as newlines. */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null
  const text = decodeEntities(
    html
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|ul|ol|div|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text || null
}

// ---------------------------------------------------------------------------
// Salary

// Amounts: "150,000", "150,000.00", "150K", "150000", or a bare "60" (only survives plausibility when hourly/monthly context annualizes it).
const MONEY = String.raw`\$?\s?(\d{2,3}(?:,\d{3})+(?:\.\d\d)?|\d{2,3}(?:\.\d+)?\s?[kK]|\d{4,7}|\d{2,3}(?:\.\d{1,2})?)`
const RANGE_RE = new RegExp(`${MONEY}\\s*(?:-|–|—|to|and)\\s*${MONEY}`, "g")
const SINGLE_RE = new RegExp(`\\$\\s?(\\d{2,3}(?:,\\d{3})+|\\d{2,3}(?:\\.\\d+)?\\s?[kK]|\\d{5,7})`, "g")

function toNumber(raw: string): number {
  const s = raw.replace(/[$,\s]/g, "")
  if (/[kK]$/.test(s)) return Math.round(parseFloat(s) * 1000)
  return parseInt(s, 10)
}

function annualize(n: number, context: string): number | null {
  if (/\b(per|an|\/)\s?(hour|hr)\b|hourly/i.test(context)) return Math.round(n * 2080)
  if (/\b(per|a|\/)\s?(month|mo)\b|monthly/i.test(context)) return n * 12
  return n
}

const PLAUSIBLE_MIN = 30_000
const PLAUSIBLE_MAX = 2_000_000

/**
 * Find a posted pay band in free text. Returns the band with the highest ceiling
 * (postings with per-geo bands list several; the top band is the one a city like
 * NYC or SF is paid on). Hourly and monthly figures are annualized.
 */
export function parseSalary(text: string | null | undefined): Salary | null {
  if (!text) return null
  let best: Salary | null = null
  const consider = (min: number | null, max: number | null, raw: string, at: number) => {
    const ctx = text.slice(Math.max(0, at - 80), at + raw.length + 80)
    const lo = min === null ? null : annualize(min, ctx)
    const hi = max === null ? null : annualize(max, ctx)
    const ceiling = hi ?? lo
    if (ceiling === null || ceiling < PLAUSIBLE_MIN || ceiling > PLAUSIBLE_MAX) return
    if (lo !== null && (lo < PLAUSIBLE_MIN || lo > PLAUSIBLE_MAX)) return
    if (lo !== null && hi !== null && lo > hi) return
    // Ranges must look like pay, not a bare "2020 to 2024" or "10 and 20".
    if (!/\$|usd|salary|pay|compensation|base|range|per year|annual/i.test(ctx)) return
    if (!best || ceiling > (best.max ?? best.min ?? 0)) best = { min: lo, max: hi, raw: raw.trim(), kind: "parsed" }
  }
  for (const m of text.matchAll(RANGE_RE)) consider(toNumber(m[1]!), toNumber(m[2]!), m[0], m.index ?? 0)
  if (!best) for (const m of text.matchAll(SINGLE_RE)) consider(toNumber(m[1]!), null, m[0], m.index ?? 0)
  return best
}

export function formatSalary(s: Salary | null): string {
  if (!s) return "—"
  const k = (n: number) => `$${Math.round(n / 1000)}k`
  const band = s.min !== null && s.max !== null ? `${k(s.min)}–${k(s.max)}` : k((s.max ?? s.min)!)
  return s.kind === "predicted" ? `~${band}` : band
}

// ---------------------------------------------------------------------------
// Years of experience

const YOE_RE =
  /(?:minimum(?: of)?|at least|min\.?)?\s*(\d{1,2})\s*(?:\+|-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?)(?:'|’)?\s+(?:of\s+)?(?:\w+[\s,/-]+){0,6}?(?:experience|exp\b|background|track record)/gi
const REQ_HEADING = /(qualifications|requirements|what (?:you|we)(?:'|’)?(?:ll| are|re)? (?:need|looking for|bring)|minimum qualifications|who you are|about you)/i
const NICE_TO_HAVE = /(nice[- ]to[- ]have|bonus|preferred|a plus|not required|even better|extra credit)/i
/** How far past a requirements heading the hard requirements plausibly run before nice-to-haves start. */
const REQ_WINDOW = 900

/**
 * The binding years-of-experience requirement. Postings often list several
 * ("3+ years in distributed systems … 5+ years professional development") and
 * the candidate must meet all of them, so within the requirements block the
 * largest wins. Outside a recognizable block, the first mention is used —
 * requirements precede nice-to-haves in nearly every posting.
 */
export function parseYoe(text: string | null | undefined): number | null {
  if (!text) return null
  const valid = (n: number) => n >= 0 && n <= 30
  const heading = REQ_HEADING.exec(text)
  if (heading) {
    const block = text.slice(heading.index, heading.index + REQ_WINDOW).split(NICE_TO_HAVE)[0]!
    const ns = [...block.matchAll(YOE_RE)].map((m) => parseInt(m[1]!, 10)).filter(valid)
    if (ns.length) return Math.max(...ns)
  }
  const m = new RegExp(YOE_RE.source, "i").exec(text)
  if (!m) return null
  const n = parseInt(m[1]!, 10)
  return valid(n) ? n : null
}

// ---------------------------------------------------------------------------
// Level and work mode from title / location text

export function levelFromTitle(title: string): Level {
  const t = title.toLowerCase()
  if (/\b(intern|internship|co-?op)\b/.test(t)) return "intern"
  if (/\b(staff|principal|distinguished|architect|director|head of|vp|fellow|lead|manager)\b/.test(t)) return "staff"
  if (/\b(senior|sr\.?|iii|3)\b/.test(t)) return "senior"
  if (/\b(new grad|early career|entry|junior|jr\.?|associate|graduate|i|1)\b/.test(t)) return "entry"
  return "mid"
}

export function workModeFrom(...hints: Array<string | null | undefined>): WorkMode | null {
  const s = hints.filter(Boolean).join(" ").toLowerCase()
  if (/\bhybrid\b/.test(s)) return "hybrid"
  if (/\bremote\b|work from home|\bwfh\b/.test(s)) return "remote"
  if (/\bon-?site\b|in[- ]office/.test(s)) return "onsite"
  return null
}

/** True for absolute http(s) URLs only; `javascript:`, `data:`, relative paths, and garbage all fail. */
export function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u).protocol
    return p === "http:" || p === "https:"
  } catch {
    return false
  }
}
