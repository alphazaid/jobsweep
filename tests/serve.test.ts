import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db.ts"
import { toCsv, toRows } from "../src/export.ts"
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
})

describe("store history + decisions", () => {
  test("runs are recorded oldest→newest; decisions upsert and clear", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsweep-store-"))
    let clock = 1_000
    const s = new Store(join(dir, "t.db"), () => clock)
    s.recordRun({ cities: ["A"], total: 10, withComp: 4, newCount: 10, carried: 0 })
    clock += 60_000
    s.recordRun({ cities: ["A"], total: 12, withComp: 5, newCount: 2, carried: 3 })
    expect(s.runs().map((r) => r.total)).toEqual([10, 12])
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
  test("run endpoint streams the search's stderr and ends with a done event", async () => {
    const start = await fetch(`${base}/api/run`, { method: "POST" })
    expect(start.status).toBe(200)
    const text = await (await fetch(`${base}/api/run/stream`)).text()
    expect(text).toContain("data: search finished")
    expect(text).toContain("event: done")
  })
})
