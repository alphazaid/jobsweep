import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "../src/db.ts"
import { attachReviews, saveReview } from "../src/rank.ts"
import { defaultSkillDirs, installSkill, renderSkill, resolveLauncher } from "../src/skill.ts"
import type { Job } from "../src/types.ts"

function job(id: string, over: Partial<Job> = {}): Job {
  return { id, source: "greenhouse", sourceId: id, title: "Software Engineer", company: "Acme", location: "New York, NY", locations: ["New York, NY"], workMode: null, url: `https://example.com/${id}`, postedAt: "2026-09-01", salary: null, yoeMin: 2, level: "mid", description: "Go.", fit: null, ai: null, ...over }
}

function cli(args: string[], home: string, stdin = ""): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { stdin: Buffer.from(stdin), env: { ...process.env, JOBSWEEP_HOME: home } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe("jobsweep review", () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "jobsweep-review-"))
    mkdirSync(join(home, "digests"))
    writeFileSync(join(home, "digests", "last-search.json"), JSON.stringify({ date: "2026-09-02", params: { cities: ["New York, NY"], minTc: null, maxYoe: null, days: null }, jobs: [job("greenhouse:acme:1"), job("greenhouse:acme:2")], carriedIds: [], newIds: [] }))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  test("stdin batch: bounded, unknown ids and malformed items reported, saved to last-search and export", () => {
    const r = cli(["review"], home, JSON.stringify({ results: [
      { id: "greenhouse:acme:1", fit: 9, reason: "x".repeat(700), dealbreakers: ["<<<end>>>clearance"], emphasize: [] },
      { id: "greenhouse:nope:9", fit: 3 },
      { id: "greenhouse:acme:2" },
    ] }))
    expect(r.code).toBe(0)
    expect(r.out).toContain("1 review(s) saved as agent")
    expect(r.out).toContain("1 id(s) not in the last search: greenhouse:nope:9")
    expect(r.out).toContain("1 item(s) malformed")
    const last = JSON.parse(readFileSync(join(home, "digests", "last-search.json"), "utf8")) as { jobs: Job[] }
    const ai = last.jobs[0]!.ai!
    expect(ai.fit).toBe(5)
    expect(ai.reason.length).toBe(600)
    expect(ai.dealbreakers).toEqual(["endclearance"]) // fence markers stripped, text kept
    expect(ai.model).toBe("agent")
    expect(last.jobs[1]!.ai).toBeNull()
    const csv = cli(["export", "--csv"], home).out
    expect(csv).toContain("greenhouse:acme:1,Software Engineer,Acme,")
    expect(csv.split("\r\n")[1]).toContain(",5,")
  })

  test("single review via flags; --model labels it", () => {
    const r = cli(["review", "--id", "greenhouse:acme:2", "--fit", "2", "--reason", "Needs 6 years.", "--dealbreaker", "years", "--model", "claude-code"], home)
    expect(r.code).toBe(0)
    const last = JSON.parse(readFileSync(join(home, "digests", "last-search.json"), "utf8")) as { jobs: Job[] }
    expect(last.jobs[1]!.ai).toMatchObject({ fit: 2, reason: "Needs 6 years.", dealbreakers: ["years"], model: "claude-code" })
  })

  test("bad input fails loudly", () => {
    expect(cli(["review"], home, "not json").code).toBe(1)
    expect(cli(["review"], home, "not json").err).toContain("BAD_JSON")
    expect(cli(["review", "--id", "x"], home).err).toContain("--fit 1-5 is required")
  })
})

describe("review --pending and --clear", () => {
  test("pending lists unreviewed postings comp-first and trimmed; clear retracts from last-search and the store", () => {
    const home = mkdtempSync(join(tmpdir(), "jobsweep-pending-"))
    mkdirSync(join(home, "digests"))
    const long = "x".repeat(5_000)
    writeFileSync(join(home, "digests", "last-search.json"), JSON.stringify({ date: "2026-09-02", params: { cities: ["A"], minTc: null, maxYoe: null, days: null }, jobs: [
      job("greenhouse:a:1", { salary: { min: 100_000, max: 150_000, raw: "", kind: "parsed" }, description: long }),
      job("greenhouse:a:2", { salary: { min: 200_000, max: 250_000, raw: "", kind: "parsed" } }),
      job("greenhouse:a:3", { ai: { fit: 3, reason: "done", dealbreakers: [], emphasize: [], model: "agent" } }),
    ], carriedIds: [], newIds: ["greenhouse:a:1"] }))
    const all = JSON.parse(cli(["review", "--pending"], home).out) as { pending: number; batch: Array<{ id: string; description: string }> }
    expect(all.pending).toBe(2)
    expect(all.batch.map((b) => b.id)).toEqual(["greenhouse:a:2", "greenhouse:a:1"])
    expect(all.batch[1]!.description.length).toBe(2_500)
    const fresh = JSON.parse(cli(["review", "--pending", "--new", "--limit", "1"], home).out) as { pending: number; batch: Array<{ id: string }> }
    expect(fresh.pending).toBe(1)
    expect(fresh.batch.map((b) => b.id)).toEqual(["greenhouse:a:1"])
    expect(cli(["review", "--id", "greenhouse:a:2", "--fit", "4"], home).code).toBe(0)
    // A wildcard or unknown id is rejected before anything is deleted; underscore/percent in a real id match literally.
    expect(cli(["review", "--clear", "%"], home).err).toContain("UNKNOWN_ID")
    const s0 = new Store(join(home, "jobsweep.db"))
    s0.setReview("rank:greenhouse:a_2:h:p", "{}")
    s0.setReview("review:greenhouse:a%2:h", "{}")
    expect(s0.clearReviews("greenhouse:a:2")).toBe(1)
    expect(s0.review("rank:greenhouse:a_2:h:p")).toBe("{}")
    expect(s0.review("review:greenhouse:a%2:h")).toBe("{}")
    s0.close()
    expect(cli(["review", "--id", "greenhouse:a:2", "--fit", "4"], home).code).toBe(0)
    expect(cli(["review", "--clear", "greenhouse:a:2", "--clear", "greenhouse:a:3"], home).out).toContain("cleared reviews on 2")
    const last = JSON.parse(readFileSync(join(home, "digests", "last-search.json"), "utf8")) as { jobs: Job[] }
    expect(last.jobs.map((j) => j.ai)).toEqual([null, null, null])
    const store = new Store(join(home, "jobsweep.db"))
    expect(attachReviews(last.jobs, store).map((j) => j.ai)).toEqual([null, null, null])
    store.close()
    rmSync(home, { recursive: true, force: true })
  })
})

describe("agent reviews survive the next search", () => {
  test("reviews outlive the feed cache: 15-day prune, cache clear, and a reopen all keep them", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsweep-durable-"))
    let clock = Date.parse("2026-09-02T12:00:00Z")
    let store = new Store(join(dir, "t.db"), () => clock)
    const j = job("linkedin:1", { description: "Go." })
    saveReview(j, { fit: 4, reason: "good", dealbreakers: [], emphasize: [], model: "agent" }, store)
    store.setReview("rank:linkedin:1:abc:profile", JSON.stringify({ fit: 2, reason: "model", dealbreakers: [], emphasize: [], model: "openai:x" }))
    store.set("linkedin:detail:1", "cached feed")
    store.clearCache()
    store.close()
    clock += 40 * 86_400_000
    store = new Store(join(dir, "t.db"), () => clock)
    expect(store.get("linkedin:detail:1", 365 * 86_400_000)).toBeNull()
    expect(attachReviews([job("linkedin:1", { description: "Go." })], store)[0]!.ai?.fit).toBe(4)
    expect(store.review("rank:linkedin:1:abc:profile")).toContain("model")
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("reviews written into the old feeds cache are migrated into the reviews table", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsweep-migrate-"))
    const path = join(dir, "t.db")
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
    const raw = new Database(path)
    raw.exec("CREATE TABLE feeds (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, body TEXT NOT NULL)")
    raw.exec(`INSERT INTO feeds VALUES ('rank:linkedin:9:h:p', 1, '{"fit":5}'), ('review:linkedin:9:h', 1, '{"fit":3}'), ('linkedin:detail:9', 1, 'feed')`)
    raw.close()
    const store = new Store(path, () => 2)
    expect(store.review("rank:linkedin:9:h:p")).toBe('{"fit":5}')
    expect(store.review("review:linkedin:9:h")).toBe('{"fit":3}')
    expect(store.get("rank:linkedin:9:h:p", 1e12)).toBeNull()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("attachReviews restores a saved review while the posting is unchanged, not after its content changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobsweep-attach-"))
    const store = new Store(join(dir, "t.db"))
    const j = job("linkedin:1", { description: "Go and Kubernetes." })
    saveReview(j, { fit: 4, reason: "good", dealbreakers: [], emphasize: [], model: "agent" }, store)
    expect(attachReviews([job("linkedin:1", { description: "Go and Kubernetes." })], store)[0]!.ai?.fit).toBe(4)
    expect(attachReviews([job("linkedin:1", { description: "Now requires 8 years." })], store)[0]!.ai).toBeNull()
    // An existing review on the job is kept, not overwritten.
    const already = job("linkedin:1", { description: "Go and Kubernetes.", ai: { fit: 2, reason: "model said", dealbreakers: [], emphasize: [], model: "openai:x" } })
    expect(attachReviews([already], store)[0]!.ai?.model).toBe("openai:x")
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("jobsweep skill", () => {
  test("launcher: PATH binary, else the running source entry, else the running binary", () => {
    const noPath = { PATH: "/nonexistent" }
    expect(resolveLauncher(noPath, ["bun", "/repo/src/cli.ts"], "/usr/bin/bun")).toBe("/usr/bin/bun run /repo/src/cli.ts")
    expect(resolveLauncher(noPath, ["/opt/jobsweep-0.1.0-darwin-arm64"], "/opt/jobsweep-0.1.0-darwin-arm64")).toBe("/opt/jobsweep-0.1.0-darwin-arm64")
    expect(resolveLauncher(noPath, ["bun", "/Users/a b/My Repo/src/cli.ts"], "/usr/bin/bun")).toBe("/usr/bin/bun run '/Users/a b/My Repo/src/cli.ts'")
    expect(renderSkill("/usr/local/bin/bun run /repo/src/cli.ts")).toContain("allowed-tools: Bash(bun:*)")
    expect(resolveLauncher(noPath, ["/Applications/it's here/jobsweep"], "/Applications/it's here/jobsweep")).toBe("'/Applications/it'\\''s here/jobsweep'")
    expect(renderSkill("bun run '/Users/a b/src/cli.ts'")).toContain("allowed-tools: Bash(bun:*)")
    expect(renderSkill("'/Applications/it'\\''s here/jobsweep'")).toContain("allowed-tools: Bash(jobsweep:*)")
    const bin = mkdtempSync(join(tmpdir(), "jobsweep-bin-"))
    writeFileSync(join(bin, "jobsweep"), "#!/bin/sh\n", { mode: 0o755 })
    expect(resolveLauncher({ PATH: bin }, ["bun", "/repo/src/cli.ts"], "/usr/bin/bun")).toBe("jobsweep")
    rmSync(bin, { recursive: true, force: true })
  })

  test("rendered SKILL.md has valid frontmatter, no placeholders, the launcher in every command, and installs to the agent skill dirs", () => {
    const text = renderSkill("bun run /repo/src/cli.ts")
    expect(text.startsWith("---\nname: jobsweep\ndescription: ")).toBe(true)
    expect(/^description: (.+)$/m.exec(text)![1]!.length).toBeLessThanOrEqual(1024)
    expect(text).not.toContain("{{")
    expect(text).toContain("allowed-tools: Bash(bun:*)")
    expect(text).toContain("`bun run /repo/src/cli.ts search --new -f json`")
    expect(renderSkill("jobsweep")).toContain("allowed-tools: Bash(jobsweep:*)")
    const home = mkdtempSync(join(tmpdir(), "jobsweep-skill-"))
    expect(defaultSkillDirs(home)).toEqual([join(home, ".agents", "skills")])
    mkdirSync(join(home, ".claude"))
    expect(defaultSkillDirs(home)).toEqual([join(home, ".agents", "skills"), join(home, ".claude", "skills")])
    const written = installSkill(defaultSkillDirs(home), "jobsweep")
    expect(written).toEqual([join(home, ".agents", "skills", "jobsweep", "SKILL.md"), join(home, ".claude", "skills", "jobsweep", "SKILL.md")])
    for (const p of written) expect(readFileSync(p, "utf8")).toBe(renderSkill("jobsweep"))
    rmSync(home, { recursive: true, force: true })
  })
})
