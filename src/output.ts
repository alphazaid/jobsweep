import { formatSalary } from "./text.ts"
import type { Job } from "./types.ts"

export type Format = "json" | "table" | "plain" | "md"
export const FORMATS: Format[] = ["json", "table", "plain", "md"]

export interface Report {
  params: Record<string, unknown>
  dropped: Record<string, number>
  errors: Array<{ source: string; error: string }>
  /** Postings that clear every filter and state comp. */
  matches: Job[]
  /** Postings that clear every filter but state no comp — kept, not dropped, so they are never silently lost. */
  unknownComp: Job[]
  newIds: Record<string, true>
  /** Not returned by the source this run; carried from an earlier observation (LinkedIn sampling). */
  carriedIds: Record<string, true>
}

/** Row marker: `*` first seen this run, `°` carried from an earlier run, else blank. */
export type Marks = Record<string, "*" | "°">

export function marksOf(r: Pick<Report, "newIds" | "carriedIds">): Marks {
  const m: Marks = {}
  for (const id of Object.keys(r.carriedIds)) m[id] = "°"
  for (const id of Object.keys(r.newIds)) m[id] = "*"
  return m
}

const SRC: Record<Job["source"], string> = { linkedin: "li", greenhouse: "gh", lever: "lv", ashby: "as", adzuna: "ad", freehire: "fh" }

function yoe(j: Job): string {
  return j.yoeMin !== null ? `${j.yoeMin}+` : `~${j.level}`
}

function date(j: Job): string {
  return j.postedAt ? j.postedAt.slice(0, 10) : "—"
}

function fit(j: Job): string {
  return j.fit ? `${j.fit.matched.length}/${j.fit.total}` : "—"
}

function ceiling(j: Job): number {
  return j.salary?.max ?? j.salary?.min ?? 0
}

export function sortByPay(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => ceiling(b) - ceiling(a) || date(b).localeCompare(date(a)))
}

/** Digest order: postings that state comp first, then by profile-skill matches, then by comp ceiling. */
export function sortByFit(jobs: Job[]): Job[] {
  return [...jobs].sort(
    (a, b) =>
      Number(!!b.salary) - Number(!!a.salary) ||
      (b.fit?.matched.length ?? 0) - (a.fit?.matched.length ?? 0) ||
      ceiling(b) - ceiling(a) ||
      date(b).localeCompare(date(a)),
  )
}

function sortByDate(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) => date(b).localeCompare(date(a)))
}

interface Col {
  h: string
  w: number
  v: (j: Job) => string
}

function table(jobs: Job[], marks: Marks): string {
  if (!jobs.length) return "  (none)"
  const hasFit = jobs.some((j) => j.fit)
  const cols: Col[] = [
    { h: "", w: 1, v: (j) => marks[j.id] ?? " " },
    ...(hasFit ? [{ h: "FIT", w: 5, v: fit }] : []),
    { h: "TITLE", w: 40, v: (j) => j.title },
    { h: "COMPANY", w: 20, v: (j) => j.company ?? "—" },
    { h: "LOCATION", w: 22, v: (j) => j.location ?? "—" },
    { h: "COMP", w: 12, v: (j) => formatSalary(j.salary) },
    { h: "YOE", w: 8, v: yoe },
    { h: "POSTED", w: 10, v: date },
    { h: "SRC", w: 3, v: (j) => SRC[j.source] },
  ]
  const cell = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s).padEnd(w)
  const header = cols.map((c) => cell(c.h, c.w)).join("  ")
  const rows = jobs.map((j) => cols.map((c) => cell(c.v(j), c.w)).join("  ") + "\n" + " ".repeat(3) + j.url)
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export function mdTable(jobs: Job[], marks: Marks): string {
  if (!jobs.length) return "_none_"
  const hasFit = jobs.some((j) => j.fit)
  const head = `| | ${hasFit ? "Fit | " : ""}Title | Company | Location | Comp | YOE | Posted | Src |\n|---|${hasFit ? "---|" : ""}---|---|---|---|---|---|---|`
  const rows = jobs.map(
    (j) =>
      `| ${marks[j.id] === "*" ? "new" : marks[j.id] === "°" ? "carried" : ""} | ${hasFit ? `${fit(j)} | ` : ""}[${j.title.replace(/\|/g, "/")}](${j.url}) | ${j.company ?? "—"} | ${j.location ?? "—"} | ${formatSalary(j.salary)} | ${yoe(j)} | ${date(j)} | ${SRC[j.source]} |`,
  )
  return [head, ...rows].join("\n")
}

function plain(jobs: Job[], marks: Marks): string {
  if (!jobs.length) return "(none)"
  return jobs
    .map((j) =>
      [
        `${marks[j.id] ? `${marks[j.id]} ` : ""}${j.title} — ${j.company ?? "—"}`,
        `  ${j.location ?? "—"} · ${formatSalary(j.salary)} · ${yoe(j)} · ${date(j)} · ${j.source}${j.fit ? ` · fit ${fit(j)}${j.fit.matched.length ? ` (${j.fit.matched.join(", ")})` : ""}` : ""}`,
        `  ${j.url}`,
      ].join("\n"),
    )
    .join("\n\n")
}

export function summary(r: Pick<Report, "matches" | "unknownComp" | "newIds" | "carriedIds" | "dropped">): string {
  const parts = [`${r.matches.length} with posted comp`, `${r.unknownComp.length} comp unknown`, `${Object.keys(r.newIds).length} new since last run`, `${Object.keys(r.carriedIds).length} carried from earlier runs`]
  const drops = Object.entries(r.dropped).map(([k, v]) => `${k} ${v}`).join(", ")
  return `${parts.join(", ")} · dropped: ${drops}`
}

export function render(r: Report, fmt: Format): string {
  const matches = sortByPay(r.matches)
  const unknown = sortByDate(r.unknownComp)
  const errs = r.errors.map((e) => `  ${e.source}: ${e.error}`)
  const marks = marksOf(r)

  if (fmt === "json") return JSON.stringify({ ...r, matches, unknownComp: unknown, newIds: Object.keys(r.newIds), carriedIds: Object.keys(r.carriedIds) }, null, 2)
  if (fmt === "md") {
    return [
      `## Matches (comp posted)`,
      "",
      mdTable(matches, marks),
      "",
      `## Comp unknown`,
      "",
      mdTable(unknown, marks),
      "",
      `_${summary(r)}_`,
      ...(errs.length ? ["", "Sources skipped:", ...errs] : []),
    ].join("\n")
  }
  const body = fmt === "table" ? table : plain
  return [
    "MATCHES (comp posted, sorted by ceiling)  * = new since last run  ° = carried from an earlier run",
    body(matches, marks),
    "",
    "COMP UNKNOWN (passes city/experience; posting states no pay)",
    body(unknown, marks),
    "",
    summary(r),
    ...(errs.length ? ["Sources skipped:", ...errs] : []),
  ].join("\n")
}

export interface Digest {
  date: string
  profileLine: string
  fresh: Job[]
  topOpen: Job[]
  totalOpen: number
  carriedIds: Record<string, true>
  dropped: Record<string, number>
  errors: Report["errors"]
}

/** Daily digest: what's new, sorted by fit then comp, plus the best of everything still open. */
export function renderDigest(d: Digest): string {
  const marks = marksOf({ newIds: {}, carriedIds: d.carriedIds })
  const lines = [
    `# Job digest — ${d.date}`,
    "",
    d.profileLine,
    "",
    `## New (${d.fresh.length})${d.fresh.some((j) => j.ai) ? " — reviewed" : ""}`,
    "",
    d.fresh.some((j) => j.ai) ? renderRanked([...d.fresh].sort((a, b) => (b.ai?.fit ?? 0) - (a.ai?.fit ?? 0)), true) : mdTable(sortByFit(d.fresh), marks),
    "",
    `## Top open by comp (${d.topOpen.length} of ${d.totalOpen})`,
    "",
    mdTable(sortByPay(d.topOpen), marks),
    "",
    `_dropped: ${Object.entries(d.dropped).map(([k, v]) => `${k} ${v}`).join(", ")}_`,
  ]
  if (d.errors.length) lines.push("", "Sources skipped:", ...d.errors.map((e) => `- ${e.source}: ${e.error}`))
  return lines.join("\n")
}

const FIT_LABEL: Record<number, string> = { 5: "apply today", 4: "apply", 3: "maybe", 2: "unlikely", 1: "skip" }

/** Ranked listing: AI fit, one-line reason, comp, years, link. Markdown when `md`, else a plain block per posting. */
export function renderRanked(jobs: Job[], md: boolean): string {
  if (!jobs.length) return md ? "_none_" : "(none)"
  if (md) {
    const head = "| Fit | Title | Company | Location | Comp | YOE | Why |\n|---|---|---|---|---|---|---|"
    const rows = jobs.map(
      (j) =>
        `| ${j.ai ? `${j.ai.fit} ${FIT_LABEL[j.ai.fit] ?? ""}` : "—"} | [${j.title.replace(/\|/g, "/")}](${j.url}) | ${j.company ?? "—"} | ${j.location ?? "—"} | ${formatSalary(j.salary)} | ${yoe(j)} | ${(j.ai?.reason ?? "").replace(/\|/g, "/")}${j.ai?.dealbreakers.length ? ` **Dealbreakers:** ${j.ai.dealbreakers.join("; ")}` : ""} |`,
    )
    return [head, ...rows].join("\n")
  }
  return jobs
    .map((j) =>
      [
        `${j.ai ? `[${j.ai.fit}/5 ${FIT_LABEL[j.ai.fit] ?? ""}]` : "[unscored]"} ${j.title} — ${j.company ?? "—"}`,
        `  ${j.location ?? "—"} · ${formatSalary(j.salary)} · ${yoe(j)} · ${date(j)} · ${SRC[j.source]}`,
        ...(j.ai ? [`  ${j.ai.reason}`] : []),
        ...(j.ai?.dealbreakers.length ? [`  dealbreakers: ${j.ai.dealbreakers.join("; ")}`] : []),
        ...(j.ai?.emphasize.length ? [`  lead with: ${j.ai.emphasize.join("; ")}`] : []),
        `  ${j.url}`,
      ].join("\n"),
    )
    .join("\n\n")
}
