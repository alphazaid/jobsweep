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
      emit(code === 0 ? "search finished" : `search exited with code ${code}`)
      run.done = true
      emit(null)
    })()
    return true
  }

  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } })
  const html = (s: string) => new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8" } })

  return Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
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
        if (path === "/api/stats.json") {
          const jobs = last?.jobs ?? []
          return json({ date: last?.date ?? null, open: jobs.length, withComp: jobs.filter((j) => j.salary).length, reviewed: jobs.filter((j) => j.ai).length, decisions: store.decisions(), runs: store.runs() })
        }
        if (path === "/api/run" && req.method === "POST") {
          if (!startRun()) return new Response("a search is already running", { status: 409 })
          return json({ started: true })
        }
        if (path === "/api/run/stream") {
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder()
              for (const l of run.lines) controller.enqueue(enc.encode(`data: ${l}\n\n`))
              if (run.done) {
                controller.enqueue(enc.encode("event: done\ndata: done\n\n"))
                controller.close()
                return
              }
              const listener = (line: string | null) => {
                if (line === null) {
                  controller.enqueue(enc.encode("event: done\ndata: done\n\n"))
                  run.listeners.delete(listener)
                  controller.close()
                } else controller.enqueue(enc.encode(`data: ${line}\n\n`))
              }
              run.listeners.add(listener)
            },
          })
          return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } })
        }
        return new Response("not found", { status: 404 })
      } finally {
        store.close()
      }
    },
  })
}
