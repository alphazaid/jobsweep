import type { Decision, Job } from "./types.ts"

export interface ExportRow {
  id: string
  title: string
  company: string
  location: string
  workMode: string
  compMin: number | null
  compMax: number | null
  compKind: string
  yearsRequired: number | null
  level: string
  skillsMatched: string
  aiFit: number | null
  aiReason: string
  aiDealbreakers: string
  decision: string
  note: string
  posted: string
  source: string
  url: string
}

export function toRows(jobs: Job[], decisions: Record<string, Decision>): ExportRow[] {
  return jobs.map((j) => ({
    id: j.id,
    title: j.title,
    company: j.company ?? "",
    location: j.location ?? "",
    workMode: j.workMode ?? "",
    compMin: j.salary?.min ?? null,
    compMax: j.salary?.max ?? null,
    compKind: j.salary?.kind ?? "",
    yearsRequired: j.yoeMin,
    level: j.level,
    skillsMatched: j.fit?.matched.join("; ") ?? "",
    aiFit: j.ai?.fit ?? null,
    aiReason: j.ai?.reason ?? "",
    aiDealbreakers: j.ai?.dealbreakers.join("; ") ?? "",
    decision: decisions[j.id]?.status ?? "",
    note: decisions[j.id]?.note ?? "",
    posted: j.postedAt?.slice(0, 10) ?? "",
    source: j.source,
    url: j.url,
  }))
}

/**
 * RFC 4180: quote when a field has a comma, quote, or newline; double embedded quotes. Numbers and nulls unquoted.
 * Titles, companies, and notes come from the web or the user: a cell starting with `=`, `+`, `-`, `@`, tab, or CR
 * would run as a formula in Excel/Sheets, so such cells get a leading apostrophe (the spreadsheet convention for "text").
 */
export function csvCell(v: string | number | null): string {
  if (v === null) return ""
  if (typeof v === "number") return String(v)
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: ExportRow[]): string {
  const cols = Object.keys(rows[0] ?? emptyRow()) as Array<keyof ExportRow>
  const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))]
  return lines.join("\r\n") + "\r\n"
}

function emptyRow(): ExportRow {
  return { id: "", title: "", company: "", location: "", workMode: "", compMin: null, compMax: null, compKind: "", yearsRequired: null, level: "", skillsMatched: "", aiFit: null, aiReason: "", aiDealbreakers: "", decision: "", note: "", posted: "", source: "", url: "" }
}
