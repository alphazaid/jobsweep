// `jobsweep serve`: a local-only HTTP server for the dashboard and triage page.
// Binds 127.0.0.1 only. No auth because nothing off-machine can reach it; the
// data is the user's own search results.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Store } from "./db.ts"
import { renderDashboard } from "./dashboard.ts"
import { toCsv, toRows } from "./export.ts"
import { matchedLocation } from "./filters.ts"
import { readEnv, readExistingProfile, writeSetup } from "./init.ts"
import { DIGEST_DIR, PROFILE_PATH } from "./paths.ts"
import { parseMoney, type Profile } from "./profile.ts"
import { ALL_SOURCES, DECISION_STATUSES, PRESETS, type DecisionStatus, type Job, type SearchParams, type Source } from "./types.ts"
import { renderUi } from "./ui.ts"

export interface LastSearch {
  date: string
  params: { cities: string[]; minTc: number | null; maxYoe: number | null; days: number | null }
  jobs: Job[]
  carriedIds?: string[]
  newIds?: string[]
}

export async function readLastSearch(): Promise<LastSearch | null> {
  const p = join(DIGEST_DIR(), "last-search.json")
  return existsSync(p) ? ((await Bun.file(p).json()) as LastSearch) : null
}

interface RunState {
  proc: ReturnType<typeof Bun.spawn> | null
  lines: string[]
  done: boolean
  listeners: Set<(line: string | null) => void>
}

/** What the dashboard's search form may set for one run. Every field optional; absent = the profile's value. */
export interface RunFields {
  preset?: string
  cities?: string[]
  minTc?: string
  maxYoe?: number
  days?: number
  remote?: "include" | "only" | "exclude"
  sources?: Source[]
  new?: boolean
  /** Also write these fields to profile.json so later runs (and the cron) use them. */
  save?: boolean
}

export function parseRunFields(v: unknown): RunFields | { error: string } {
  if (!v || typeof v !== "object") return { error: "fields must be an object" }
  const b = v as Record<string, unknown>
  const out: RunFields = {}
  if (b.preset != null) {
    if (typeof b.preset !== "string" || !PRESETS[b.preset]) return { error: `preset must be one of ${Object.keys(PRESETS).join(", ")}` }
    out.preset = b.preset
  }
  if (b.cities != null) {
    const list = typeof b.cities === "string" ? b.cities.split(";") : Array.isArray(b.cities) ? b.cities : null
    if (!list || !list.every((c) => typeof c === "string")) return { error: "cities must be a string (separate with ;) or an array" }
    const cities = (list as string[]).map((c) => c.trim()).filter(Boolean)
    if (!cities.length) return { error: "at least one city" }
    if (cities.some((c) => c.length > 80 || /[\x00-\x1f]/.test(c))) return { error: "city looks wrong" }
    out.cities = cities
  }
  if (b.minTc != null && String(b.minTc).trim() !== "") {
    const s = String(b.minTc).trim()
    if (parseMoney(s) === null) return { error: `comp floor "${s}" isn't a number (try 180k or 180000)` }
    out.minTc = s
  }
  for (const k of ["maxYoe", "days"] as const) {
    if (b[k] != null && String(b[k]).trim() !== "") {
      const n = Number(b[k])
      if (!Number.isInteger(n) || n < (k === "days" ? 1 : 0) || n > 3650) return { error: `${k} must be a whole number` }
      out[k] = n
    }
  }
  if (b.remote != null) {
    if (!["include", "only", "exclude"].includes(String(b.remote))) return { error: "remote must be include, only, or exclude" }
    out.remote = b.remote as RunFields["remote"]
  }
  if (b.sources != null) {
    if (!Array.isArray(b.sources) || !b.sources.every((x) => typeof x === "string" && ALL_SOURCES.includes(x as Source))) return { error: `sources must be a subset of ${ALL_SOURCES.join(", ")}` }
    if (!b.sources.length) return { error: "pick at least one source" }
    out.sources = b.sources as Source[]
  }
  if (b.new != null) out.new = !!b.new
  if (b.save != null) out.save = !!b.save
  return out
}

/** The CLI flags for one run. Each value is its own argv element — no shell, no quoting. */
export function runArgs(f: RunFields): string[] {
  const a: string[] = []
  for (const c of f.cities ?? []) a.push("-l", c)
  if (f.minTc !== undefined) a.push("--min-tc", f.minTc)
  if (f.maxYoe !== undefined) a.push("--max-yoe", String(f.maxYoe))
  if (f.days !== undefined) a.push("--days", String(f.days))
  if (f.remote !== undefined) a.push("--remote", f.remote)
  if (f.sources !== undefined) a.push("--sources", f.sources.join(","))
  if (f.preset !== undefined) a.push("--preset", f.preset)
  if (f.new) a.push("--new")
  return a
}

/** Write the form's fields into profile.json via the same core `init` uses; unset fields keep their current values. */
function saveAsDefaults(f: RunFields, current: Profile | null): void {
  const existing = readExistingProfile()
  const env = readEnv()
  const preset = f.preset ?? String(existing.preset ?? current?.preset.name ?? "swe")
  writeSetup({
    preset,
    cities: f.cities ?? ((existing.cities as string[] | undefined) ?? []),
    minTc: f.minTc ?? (existing.minTc == null ? "" : String(existing.minTc)),
    maxYoe: f.maxYoe !== undefined ? String(f.maxYoe) : existing.maxYoe == null ? "" : String(existing.maxYoe),
    days: f.days ?? Number(existing.days ?? 14),
    remote: f.remote ?? String(existing.remote ?? "include"),
    skills: existing.preset === preset ? ((existing.skills as string[] | undefined) ?? PRESETS[preset]!.skills) : PRESETS[preset]!.skills,
    linkedin: f.sources ? f.sources.includes("linkedin") && existing.linkedinAccepted === true : existing.linkedinAccepted === true,
    adzunaId: env.ADZUNA_APP_ID ?? "",
    adzunaKey: env.ADZUNA_APP_KEY ?? "",
    installSkill: false,
  })
  if (f.sources) {
    // writeSetup derives sources from keys/consent; an explicit narrower pick is written on top of that.
    const path = PROFILE_PATH()
    const p = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    p.sources = f.sources.filter((src) => src !== "linkedin" || existing.linkedinAccepted === true)
    writeFileSync(path, JSON.stringify(p, null, 2) + "\n")
  }
}

export interface ServeOptions {
  port: number
  profile: Profile | null
  /** How to launch a search; the CLI passes its own entrypoint so the server works from source and from the binary. */
  searchCommand: string[]
  log: (m: string) => void
}

const RUN_TIMEOUT_MS = 15 * 60_000

/** The numbers behind the dashboard's cards, for `serve --json` / `--summary` and /api/stats.json. */
export function statsOf(last: LastSearch | null, store: Store) {
  const jobs = last?.jobs ?? []
  const decisions = store.decisions()
  const count = (s: string) => jobs.filter((j) => decisions[j.id]?.status === s).length
  const ceilings = jobs.map((j) => j.salary?.max ?? j.salary?.min).filter((n): n is number => n != null).sort((a, b) => a - b)
  return {
    date: last?.date ?? null,
    cities: last?.params.cities ?? [],
    open: jobs.length,
    new: last?.newIds?.length ?? 0,
    carried: last?.carriedIds?.length ?? 0,
    withComp: ceilings.length,
    medianCeiling: ceilings.length ? ceilings[Math.floor(ceilings.length / 2)]! : null,
    reviewed: jobs.filter((j) => j.ai).length,
    decisions: { apply: count("apply"), maybe: count("maybe"), applied: count("applied"), skip: count("skip"), toReview: jobs.length - count("apply") - count("maybe") - count("applied") - count("skip") },
    runs: store.runs(),
  }
}

export function summaryText(s: ReturnType<typeof statsOf>): string {
  if (!s.date) return "No search yet - run `jobsweep search` first.\n"
  const k = (n: number | null) => (n == null ? "-" : `$${Math.round(n / 1000)}k`)
  return [
    `jobsweep · ${s.cities.join(" / ")} · last search ${s.date}`,
    `  open ${s.open} · new ${s.new} · carried ${s.carried}`,
    `  with comp ${s.withComp} (${s.open ? Math.round((s.withComp / s.open) * 100) : 0}%) · median ceiling ${k(s.medianCeiling)}`,
    `  apply ${s.decisions.apply} · maybe ${s.decisions.maybe} · applied ${s.decisions.applied} · skipped ${s.decisions.skip} · to review ${s.decisions.toReview}`,
    `  AI reviewed ${s.reviewed} · runs recorded ${s.runs.length}`,
  ].join("\n") + "\n"
}

export function startServer(o: ServeOptions): ReturnType<typeof Bun.serve> {
  const run: RunState = { proc: null, lines: [], done: true, listeners: new Set() }

  const emit = (line: string | null) => {
    if (line !== null) run.lines.push(line)
    for (const l of run.listeners) l(line)
  }

  const startRun = (extraArgs: string[] = []): boolean => {
    if (run.proc && !run.done) return false
    run.lines = []
    run.done = false
    if (extraArgs.length) emit(`search ${extraArgs.join(" ")}`)
    const proc = Bun.spawn([...o.searchCommand, ...extraArgs], { stdout: "ignore", stderr: "pipe", env: process.env })
    run.proc = proc
    // A wedged provider must not leave the button stuck on "running…" and /api/run answering 409 forever.
    const deadline = setTimeout(() => {
      if (!run.done) {
        emit(`search exceeded ${RUN_TIMEOUT_MS / 60_000} minutes; killed`)
        proc.kill()
      }
    }, RUN_TIMEOUT_MS)
    ;(async () => {
      const reader = proc.stderr.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          emit(buf.slice(0, nl).replace(/^# /, ""))
          buf = buf.slice(nl + 1)
        }
      }
      if (buf) emit(buf)
      const code = await proc.exited
      clearTimeout(deadline)
      emit(code === 0 ? "search finished" : `search exited with code ${code}`)
      run.done = true
      emit(null)
    })()
    return true
  }

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } })
  const html = (s: string) => new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8" } })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    // Page and API requests are quick; the run stream opts out per-request below (server.timeout(req, 0)).
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url)
      const store = new Store()
      try {
        const last = await readLastSearch()
        const path = url.pathname

        if (path === "/" || path === "/dashboard") {
          if (!last) return html(`<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:40px">No search yet. Run <code>jobsweep search</code>, then reload.</body>`)
          return html(
            renderDashboard({
              date: last.date,
              cities: last.params.cities,
              jobs: last.jobs,
              newIds: new Set(last.newIds ?? []),
              carriedIds: new Set(last.carriedIds ?? []),
              decisions: store.decisions(),
              runs: store.runs(),
              theme: o.profile?.theme ?? undefined,
              profile: o.profile
                ? { preset: o.profile.preset.name, cities: o.profile.cities, minTc: o.profile.minTc, maxYoe: o.profile.maxYoe, days: o.profile.days, remote: o.profile.remote, sources: o.profile.sources, linkedinAccepted: o.profile.linkedinAccepted }
                : null,
            }),
          )
        }

        if (path === "/triage") {
          if (!last) return Response.redirect("/", 302)
          const cityParams = last.params.cities.map((city) => ({ city, remote: "exclude" as const }))
          const fmtTc = last.params.minTc == null ? "any comp" : `≥ $${Math.round(last.params.minTc / 1000)}k`
          const fmtYoe = last.params.maxYoe == null ? "any yrs" : `≤ ${last.params.maxYoe} yrs`
          return html(
            renderUi(last.jobs, {
              title: `Jobs · ${last.params.cities.join(" / ")}`,
              subtitle: `${last.date} · ${fmtTc} · ${fmtYoe}${last.params.days != null ? ` · ${last.params.days} d` : ""}`,
              date: last.date,
              floor: last.params.minTc,
              skills: o.profile?.skills ?? [],
              isLocal: (j) => cityParams.some((p) => matchedLocation(j, { ...p } as SearchParams) !== null),
              storageKey: `jobsweep:${last.params.cities.join("|")}`,
              decisions: store.decisions(),
              serverSync: true,
              theme: o.profile?.theme ?? undefined,
            }),
          )
        }

        if (path === "/api/jobs.json") return json(last ? toRows(last.jobs, store.decisions()) : [])
        if (path === "/api/jobs.csv") {
          return new Response(toCsv(toRows(last?.jobs ?? [], store.decisions())), {
            headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="jobsweep-${last?.date ?? "export"}.csv"` },
          })
        }
        if (path === "/api/decisions.json") return json(store.decisions())
        if (path === "/api/decisions" && req.method === "POST") {
          const body: unknown = await req.json()
          if (!body || typeof body !== "object" || !("id" in body) || typeof body.id !== "string") return json({ error: "id required" }, 400)
          const status = "status" in body && typeof body.status === "string" ? body.status : ""
          if (status && !DECISION_STATUSES.includes(status as DecisionStatus)) return json({ error: `status must be one of ${DECISION_STATUSES.join(", ")} or empty` }, 400)
          const note = "note" in body && typeof body.note === "string" ? body.note.slice(0, 4000) : ""
          store.setDecision(body.id.slice(0, 300), status as DecisionStatus | "", note)
          return json({ ok: true })
        }
        if (path === "/api/stats.json") return json(statsOf(last, store))
        if (path === "/api/run" && req.method === "POST") {
          // Optional body: the form's fields. Validated here, turned into CLI flags; never shelled through a string.
          let fields: RunFields = {}
          const raw = (await req.text()).trim()
          if (raw) {
            let body: unknown
            try {
              body = JSON.parse(raw)
            } catch {
              return json({ error: "body must be JSON" }, 400)
            }
            const parsed = parseRunFields(body)
            if ("error" in parsed) return json({ error: parsed.error }, 400)
            fields = parsed
          }
          if (fields.save) {
            try {
              saveAsDefaults(fields, o.profile)
            } catch (e) {
              return json({ error: e instanceof Error ? e.message : String(e) }, 400)
            }
          }
          if (!startRun(runArgs(fields))) return new Response("a search is already running", { status: 409 })
          return json({ started: true, args: runArgs(fields), saved: !!fields.save })
        }
        if (path === "/api/run/stream") {
          // A client that goes away mid-run (tab closed, idle timeout) must only detach its listener — never
          // take the server down on the next progress line.
          let listener: ((line: string | null) => void) | null = null
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder()
              const push = (chunk: string) => {
                try {
                  controller.enqueue(enc.encode(chunk))
                } catch {
                  if (listener) run.listeners.delete(listener)
                  listener = null
                }
              }
              for (const l of run.lines) push(`data: ${l}\n\n`)
              if (run.done) {
                push("event: done\ndata: done\n\n")
                controller.close()
                return
              }
              listener = (line) => {
                if (line === null) {
                  push("event: done\ndata: done\n\n")
                  if (listener) run.listeners.delete(listener)
                  try {
                    controller.close()
                  } catch {}
                } else push(`data: ${line}\n\n`)
              }
              run.listeners.add(listener)
            },
            cancel() {
              if (listener) run.listeners.delete(listener)
              listener = null
            },
          })
          server.timeout(req, 0)
          return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
        }
        return new Response("not found", { status: 404 })
      } finally {
        store.close()
      }
    },
  })
  return server
}
