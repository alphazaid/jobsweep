// `jobsweep serve`: a local-only HTTP server for the dashboard and triage page.
// Binds 127.0.0.1 only. No auth because nothing off-machine can reach it; the
// data is the user's own search results.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Store } from "./db.ts"
import { renderDashboard } from "./dashboard.ts"
import { toCsv, toRows } from "./export.ts"
import { matchedLocation } from "./filters.ts"
import { DIGEST_DIR } from "./paths.ts"
import type { Profile } from "./profile.ts"
import { DECISION_STATUSES, type DecisionStatus, type Job, type SearchParams } from "./types.ts"
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

  const startRun = (): boolean => {
    if (run.proc && !run.done) return false
    run.lines = []
    run.done = false
    const proc = Bun.spawn(o.searchCommand, { stdout: "ignore", stderr: "pipe", env: process.env })
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
          if (!startRun()) return new Response("a search is already running", { status: 409 })
          return json({ started: true })
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
