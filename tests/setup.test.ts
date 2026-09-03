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
  test("--dry-run validates and previews the profile, writes nothing, never shows secrets", () => {
    const r = cli(["init", "--cities", "Austin, TX", "--min-tc", "180k", "--dry-run", "--json"], { ADZUNA_APP_ID: "id1", ADZUNA_APP_KEY: "sekrit" })
    expect(r.code).toBe(0)
    const j = JSON.parse(r.out) as { dryRun: boolean; profile: Record<string, unknown>; envPath: string | null; skillPaths: string[] }
    expect(j.dryRun).toBe(true)
    expect(j.profile).toMatchObject({ cities: ["Austin, TX"], minTc: 180000, sources: ["greenhouse", "lever", "ashby", "adzuna", "freehire"] })
    expect(j.envPath).toBe(join(home, SECRETS_FILE))
    expect(j.skillPaths.length).toBeGreaterThan(0)
    expect(r.out).not.toContain("sekrit")
    expect(existsSync(join(home, "profile.json"))).toBe(false)
    expect(existsSync(join(home, SECRETS_FILE))).toBe(false)
    expect(existsSync(join(home, "companies.json"))).toBe(false)
    // Human-readable form says so too, and still validates.
    expect(cli(["init", "--cities", "Austin, TX", "--dry-run", "--no-skill"]).out).toContain("Dry run — nothing written")
    expect(cli(["init", "--cities", "Austin, TX", "--min-tc", "lots", "--dry-run"]).err).toContain("isn't a number")
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

describe("presets", () => {
  test("--preset selects the field; switching presets resets skills/exclude, same preset keeps them; unknown rejected", () => {
    expect(cli(["init", "--preset", "finance", "--cities", "Chicago, IL", "--no-skill"]).code).toBe(0)
    expect(profile()).toMatchObject({ preset: "finance", exclude: ["intern", "contract"] })
    expect(profile().skills).toContain("GAAP")
    cli(["init", "--skills", "Excel,SQL", "--no-skill"])
    expect(profile()).toMatchObject({ preset: "finance", skills: ["Excel", "SQL"] })
    cli(["init", "--preset", "legal", "--no-skill"])
    expect(profile().skills).toContain("Westlaw")
    expect(cli(["init", "--preset", "astronaut", "--no-skill"]).err).toContain("preset must be one of")
    const list = cli(["presets"]).out
    expect(list).toContain("healthcare")
    expect(list).toContain("registered nurse")
  })
  test("each preset's title gate admits its own roles and rejects the SWE noise", async () => {
    const { PRESETS } = await import("../src/types.ts")
    const re = (n: string) => new RegExp(PRESETS[n]!.titlePattern, "i")
    expect(re("healthcare").test("Registered Nurse - ICU")).toBe(true)
    expect(re("healthcare").test("Software Engineer, Healthcare")).toBe(false)
    expect(re("finance").test("Senior Financial Analyst")).toBe(true)
    expect(re("finance").test("Financial Software Engineer")).toBe(false)
    expect(re("data").test("Data Engineer")).toBe(true)
    expect(re("data").test("Data Center Technician")).toBe(false)
    expect(re("product").test("Senior Product Manager")).toBe(true)
    expect(re("product").test("Product Designer")).toBe(false)
    expect(re("sales").test("Account Executive, Mid-Market")).toBe(true)
    expect(re("legal").test("Corporate Counsel")).toBe(true)
    expect(re("any").test("Underwater Basket Weaver")).toBe(true)
    for (const [k, p] of Object.entries(PRESETS)) expect(Array.isArray(p.discoverCategories), k).toBe(true)
  })
})

describe("init (interactive)", () => {
  test("answers on stdin produce the same profile as flags", () => {
    const r = cli(["init"], {}, "\nBoston, MA\n150k\n2\n7\nonly\nRust, Go\nn\n\nn\n")
    expect(r.code).toBe(0)
    expect(profile()).toMatchObject({ preset: "swe", cities: ["Boston, MA"], minTc: 150000, maxYoe: 2, days: 7, remote: "only", skills: ["Rust", "Go"], linkedinAccepted: false })
    // Choosing a preset in the first answer takes its skills and exclude list.
    const r2 = cli(["init"], {}, "healthcare\nBoston, MA\n\n\n\n\n\nn\n\nn\n")
    expect(r2.code).toBe(0)
    expect(profile()).toMatchObject({ preset: "healthcare", exclude: ["intern", "travel"] })
    expect((profile().skills as string[])).toContain("Epic")
    expect(cli(["init"], {}, "underwater-basket\n").code).toBe(1)
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
