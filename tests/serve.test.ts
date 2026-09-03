import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db.ts"
import { csvCell, toCsv, toRows } from "../src/export.ts"
import { isHttpUrl } from "../src/text.ts"
import { startServer } from "../src/serve.ts"
import type { Job } from "../src/types.ts"

function job(id: string, over: Partial<Job> = {}): Job {
  return { id, source: "greenhouse", sourceId: id, title: "Software Engineer", company: "Acme, Inc", location: "New York, NY", locations: ["New York, NY"], workMode: null, url: `https://example.com/${id}`, postedAt: "2026-09-01", salary: { min: 200_000, max: 250_000, raw: "", kind: "parsed" }, yoeMin: 2, level: "mid", description: "Go.", fit: { matched: ["Go"], total: 3 }, ai: null, ...over }
}

describe("export", () => {
  test("CSV quotes commas, quotes and newlines; nulls empty; decisions joined in", () => {
    const rows = toRows([job("a", { title: 'Engineer, "Platform"', description: "x" }), job("b", { salary: null, company: "Multi\nLine" })], { a: { status: "apply", note: "call recruiter, Tue", updatedAt: 1 } })
    const csv = toCsv(rows)
    const lines = csv.split("\r\n")
    expect(lines[0]).toBe("id,title,company,location,workMode,compMin,compMax,compKind,yearsRequired,level,skillsMatched,aiFit,aiReason,aiDealbreakers,decision,note,posted,source,url")
    expect(lines[1]).toContain('"Engineer, ""Platform"""')
    expect(lines[1]).toContain(',apply,"call recruiter, Tue",')
    expect(lines[2]).toContain('"Multi\nLine"')
    expect(lines[2]).toContain(",,,,2,") // compMin, compMax, compKind empty for no salary
  })

  test("cells that a spreadsheet would run as formulas are neutralised", () => {
    expect(csvCell("=1+1")).toBe("'=1+1")
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`)
    expect(csvCell("+1 (555)")).toBe("'+1 (555)")
    expect(csvCell("-senior")).toBe("'-senior")
    expect(csvCell("@acme")).toBe("'@acme")
    expect(csvCell("Engineer")).toBe("Engineer")
    expect(csvCell(-5)).toBe("-5")
  })
  test("only http(s) posting URLs are accepted", () => {
    expect(isHttpUrl("https://jobs.example.com/1")).toBe(true)
    expect(isHttpUrl("javascript:alert(1)")).toBe(false)
    expect(isHttpUrl("data:text/html,hi")).toBe(false)
    expect(isHttpUrl("/relative")).toBe(false)
  })
})

describe("store history + decisions", () => {
  test("runs are recorded oldest→newest, same-millisecond runs both kept; decisions upsert and clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsweep-store-"))
    let clock = 1_000
    const s = new Store(join(dir, "t.db"), () => clock)
    s.recordRun({ cities: ["A"], total: 10, withComp: 4, newCount: 10, carried: 0 })
    s.recordRun({ cities: ["A"], total: 11, withComp: 4, newCount: 1, carried: 0 })
    clock += 60_000
    s.recordRun({ cities: ["A"], total: 12, withComp: 5, newCount: 2, carried: 3 })
    expect(s.runs().map((r) => r.total)).toEqual([10, 11, 12])
    s.setDecision("j1", "apply", "")
    s.setDecision("j1", "applied", "sent 9/2")
    s.setDecision("j2", "skip", "")
    expect(s.decisions()).toMatchObject({ j1: { status: "applied", note: "sent 9/2" }, j2: { status: "skip" } })
    s.setDecision("j2", "", "")
    expect(Object.keys(s.decisions())).toEqual(["j1"])
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("store migration", () => {
  test("a runs table keyed by ts alone is rebuilt with an id and keeps its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsweep-mig-"))
    const path = join(dir, "t.db")
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const raw = new Database(path)
    raw.exec("CREATE TABLE runs (ts INTEGER PRIMARY KEY, cities TEXT NOT NULL, total INTEGER NOT NULL, with_comp INTEGER NOT NULL, new_count INTEGER NOT NULL, carried INTEGER NOT NULL)")
    raw.exec("INSERT INTO runs VALUES (5, 'A', 7, 3, 7, 0)")
    raw.close()
    const s = new Store(path, () => 6)
    s.recordRun({ cities: ["A"], total: 8, withComp: 3, newCount: 1, carried: 2 })
    expect(s.runs().map((r) => [r.ts, r.total])).toEqual([[5, 7], [6, 8]])
    expect(s.runs().map((r) => r.cities)).toEqual([["A"], ["A"]])
    s.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("serve", () => {
  let home: string
  let server: ReturnType<typeof startServer>
  let base: string
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "jobsweep-serve-"))
    process.env.JOBSWEEP_HOME = home
    mkdirSync(join(home, "digests"))
    writeFileSync(join(home, "digests", "last-search.json"), JSON.stringify({ date: "2026-09-02", params: { cities: ["New York, NY"], minTc: 200000, maxYoe: 3, days: 14 }, jobs: [job("greenhouse:acme:1"), job("greenhouse:acme:2", { salary: null })], carriedIds: ["greenhouse:acme:2"], newIds: ["greenhouse:acme:1"] }))
    server = startServer({ port: 0, profile: null, searchCommand: ["true"], log: () => {} })
    base = `http://127.0.0.1:${server.port}`
  })
  afterAll(() => {
    server.stop(true)
    delete process.env.JOBSWEEP_HOME
    rmSync(home, { recursive: true, force: true })
  })

  test("dashboard renders counts", async () => {
    const html = await (await fetch(`${base}/`)).text()
    expect(html).toContain("open matches")
    expect(html).toContain('<div class="n">2</div>')
    expect(html).toContain("1 carried · 1 new")
  })
  test("decisions round-trip and appear in the export and the triage page", async () => {
    const r = await fetch(`${base}/api/decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "greenhouse:acme:1", status: "apply", note: "hi" }) })
    expect(r.status).toBe(200)
    expect(await (await fetch(`${base}/api/decisions.json`)).json()).toMatchObject({ "greenhouse:acme:1": { status: "apply", note: "hi" } })
    const csv = await (await fetch(`${base}/api/jobs.csv`)).text()
    expect(csv).toContain("greenhouse:acme:1,Software Engineer")
    expect(csv).toContain(",apply,hi,")
    const triage = await (await fetch(`${base}/triage`)).text()
    expect(triage).toContain("const SYNC=true")
    expect(triage).toContain('"greenhouse:acme:1":{"s":"apply","n":"hi"')
    const bad = await fetch(`${base}/api/decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "x", status: "yolo" }) })
    expect(bad.status).toBe(400)
  })
  test("a stream client that disconnects mid-run does not take the server down", async () => {
    // A slow fake search: emits one line, waits, emits another. The first client drops after the first line.
    const home2 = mkdtempSync(join(tmpdir(), "jobsweep-serve-slow-"))
    const prevHome = process.env.JOBSWEEP_HOME
    process.env.JOBSWEEP_HOME = home2
    mkdirSync(join(home2, "digests"))
    writeFileSync(join(home2, "digests", "last-search.json"), JSON.stringify({ date: "2026-09-02", params: { cities: ["A"], minTc: null, maxYoe: null, days: null }, jobs: [], carriedIds: [], newIds: [] }))
    const slow = startServer({ port: 0, profile: null, searchCommand: ["sh", "-c", "echo '# one' >&2; sleep 0.6; echo '# two' >&2"], log: () => {} })
    const b = `http://127.0.0.1:${slow.port}`
    try {
      expect((await fetch(`${b}/api/run`, { method: "POST" })).status).toBe(200)
      const ac = new AbortController()
      const first = await fetch(`${b}/api/run/stream`, { signal: ac.signal })
      const reader = first.body!.getReader()
      const { value } = await reader.read()
      expect(new TextDecoder().decode(value)).toContain("data: one")
      ac.abort() // client gone while the search is still running
      await Bun.sleep(900) // "two" and the done event fire against the dead client
      // Server still alive and the late lines are replayed to a fresh client.
      const text = await (await fetch(`${b}/api/run/stream`)).text()
      expect(text).toContain("data: two")
      expect(text).toContain("event: done")
      expect((await fetch(`${b}/api/stats.json`)).status).toBe(200)
    } finally {
      slow.stop(true)
      process.env.JOBSWEEP_HOME = prevHome
      rmSync(home2, { recursive: true, force: true })
    }
  })
  test("run endpoint streams the search's stderr and ends with a done event", async () => {
    const start = await fetch(`${base}/api/run`, { method: "POST" })
    expect(start.status).toBe(200)
    const text = await (await fetch(`${base}/api/run/stream`)).text()
    expect(text).toContain("data: search finished")
    expect(text).toContain("event: done")
  })
})
