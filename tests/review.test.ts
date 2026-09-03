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

describe("agent reviews survive the next search", () => {
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
    expect(resolveLauncher(noPath, ["bun", "/repo/src/cli.ts"], "/usr/bin/bun")).toBe("bun run /repo/src/cli.ts")
    expect(resolveLauncher(noPath, ["/opt/jobsweep-0.1.0-darwin-arm64"], "/opt/jobsweep-0.1.0-darwin-arm64")).toBe("/opt/jobsweep-0.1.0-darwin-arm64")
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
