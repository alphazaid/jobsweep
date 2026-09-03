import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SECRETS_FILE = ".env"
let home: string
const cli = (args: string[], env: Record<string, string> = {}, stdin = "") => {
  const base = { ...process.env }
  delete base.ADZUNA_APP_ID
  delete base.ADZUNA_APP_KEY
  const r = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { stdin: Buffer.from(stdin), env: { ...base, JOBSWEEP_HOME: home, ...env }, stdout: "pipe", stderr: "pipe" })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
const profile = () => JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as Record<string, unknown>

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jobsweep-setup-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe("init --flags (unattended)", () => {
  test("writes profile + seed boards from flags; --json reports paths, never secrets", () => {
    const r = cli(["init", "--cities", "Austin, TX;Denver, CO", "--min-tc", "180k", "--max-yoe", "4", "--skills", "Go, TypeScript", "--no-skill", "--json"])
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out) as { profilePath: string; envPath: string | null; seeded: number; skillPaths: string[] }
    expect(j.profilePath).toBe(join(home, "profile.json"))
    expect(j.envPath).toBeNull()
    expect(j.seeded).toBeGreaterThan(100)
    expect(j.skillPaths).toEqual([])
    expect(profile()).toMatchObject({ cities: ["Austin, TX", "Denver, CO"], minTc: 180000, maxYoe: 4, skills: ["Go", "TypeScript"], remote: "include", days: 14, sources: ["greenhouse", "lever", "ashby", "freehire"], linkedinAccepted: false })
    expect(existsSync(join(home, "companies.json"))).toBe(true)
  })
  test("re-run with fewer flags keeps values; Adzuna comes from the environment only and lands in a 600 secrets file", () => {
    cli(["init", "--cities", "Austin, TX", "--min-tc", "180k", "--no-skill"])
    const r = cli(["init", "--no-skill", "--json"], { ADZUNA_APP_ID: "id1", ADZUNA_APP_KEY: "sekrit" })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("sekrit")
    expect(profile()).toMatchObject({ cities: ["Austin, TX"], minTc: 180000, sources: ["greenhouse", "lever", "ashby", "adzuna", "freehire"] })
    expect(readFileSync(join(home, SECRETS_FILE), "utf8")).toBe("ADZUNA_APP_ID=id1\nADZUNA_APP_KEY=sekrit\n")
    expect(statSync(join(home, SECRETS_FILE)).mode & 0o777).toBe(0o600)
    // No flag exists for the key: passing one is rejected, so it can never land in shell history by our doing.
    expect(cli(["init", "--adzuna-key", "x"]).code).toBe(1)
  })
  test("first run without --cities fails; bad values fail before anything is written", () => {
    expect(cli(["init", "--min-tc", "1k"]).err).toContain("NO_CITY")
    expect(cli(["init", "--cities", "X", "--min-tc", "lots"]).err).toContain("isn't a number")
    expect(cli(["init", "--cities", "X", "--remote", "sometimes"]).err).toContain("remote must be")
    expect(existsSync(join(home, "profile.json"))).toBe(false)
  })
  test("--linkedin opts in; --no-linkedin turns it off on a re-run", () => {
    cli(["init", "--cities", "X", "--linkedin", "--no-skill"])
    expect(profile()).toMatchObject({ linkedinAccepted: true, sources: ["greenhouse", "lever", "ashby", "freehire", "linkedin"] })
    cli(["init", "--no-linkedin", "--no-skill"])
    expect(profile()).toMatchObject({ linkedinAccepted: false, sources: ["greenhouse", "lever", "ashby", "freehire"] })
  })
})

describe("init (interactive)", () => {
  test("answers on stdin produce the same profile as flags", () => {
    const r = cli(["init"], {}, "Boston, MA\n150k\n2\n7\nonly\nRust, Go\nn\n\nn\n")
    expect(r.code).toBe(0)
    expect(profile()).toMatchObject({ cities: ["Boston, MA"], minTc: 150000, maxYoe: 2, days: 7, remote: "only", skills: ["Rust", "Go"], linkedinAccepted: false })
  })
})

describe("doctor", () => {
  test("fails on an empty machine naming the fix; passes after init; json mirrors the lines", () => {
    const before = cli(["doctor"])
    expect(before.code).toBe(1)
    expect(before.out).toMatch(/FAIL profile .*fix: jobsweep init/s)
    cli(["init", "--cities", "Austin, TX", "--no-skill"])
    const after = cli(["doctor"])
    expect(after.code).toBe(0)
    expect(after.out).toContain("ok   profile     Austin, TX · any comp · any yrs")
    expect(after.out).toContain("the seed list")
    const j = JSON.parse(cli(["doctor", "--json"]).out) as Array<{ name: string; ok: boolean; required: boolean }>
    expect(j.find((c) => c.name === "profile")).toMatchObject({ ok: true, required: true })
    expect(j.find((c) => c.name === "search")).toMatchObject({ ok: false, required: false })
  })
  test("a broken profile is a FAIL with the parse error, not a crash", () => {
    writeFileSync(join(home, "profile.json"), '{"cities": [], "bogus": 1}')
    const r = cli(["doctor"])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/FAIL profile .*bogus/)
  })
})
