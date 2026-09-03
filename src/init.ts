import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import companiesSeed from "../companies.seed.json"
import { knownMetro } from "./filters.ts"
import { join } from "node:path"
import { COMPANIES_PATH, ENV_PATH, PROFILE_PATH, configDir } from "./paths.ts"
import { LINKEDIN_NOTICE, parseMoney } from "./profile.ts"
import { defaultSkillDirs, installSkill } from "./skill.ts"
import { DEFAULT_PRESET } from "./types.ts"

const out = (s = "") => process.stdout.write(s + "\n")

/** Ask on stdin; empty answer returns `def`. */
function ask(q: string, def?: string): string {
  const a = prompt(def === undefined ? `${q}: ` : `${q} [${def}]: `)
  return (a ?? "").trim() || def || ""
}

function yes(q: string, def = true): boolean {
  const a = ask(`${q} (${def ? "Y/n" : "y/N"})`, def ? "y" : "n").toLowerCase()
  return a.startsWith("y")
}

/** Everything setup needs, however it was collected. Strings are as a user would type them. */
export interface SetupAnswers {
  cities: string[]
  minTc: string
  maxYoe: string
  days: number
  remote: string
  skills: string[]
  linkedin: boolean
  adzunaId: string
  adzunaKey: string
  installSkill: boolean
}

export interface SetupResult {
  profilePath: string
  envPath: string | null
  companiesPath: string
  seeded: number
  skillPaths: string[]
  notes: string[]
  /** The profile as it was (or would be) written. Never contains secrets. */
  profile: Record<string, unknown>
  /** True when nothing was written (`--dry-run`). */
  dryRun: boolean
}

export function readExistingProfile(): Record<string, unknown> {
  const p = PROFILE_PATH()
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {}
}

export function readEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const envPath = ENV_PATH()
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
      if (m) env[m[1]!] = m[2]!
    }
  }
  return env
}

/**
 * Validate and write profile.json, the secrets file, companies.json, and the agent skill. Throws on bad input; writes
 * nothing then. With `dryRun`, validates and reports exactly what would be written, touching nothing.
 */
export function writeSetup(a: SetupAnswers, dryRun = false): SetupResult {
  const notes: string[] = []
  if (!a.cities.length) throw new Error("at least one city is required (e.g. \"New York, NY\")")
  for (const c of a.cities) if (!knownMetro(c)) notes.push(`no suburb aliases for "${c}" yet — only exact city text matches; add some to ${configDir()}/metros.json (see README)`)
  const minTc = a.minTc ? parseMoney(a.minTc) : null
  if (a.minTc && minTc === null) throw new Error(`comp floor "${a.minTc}" isn't a number I understand (try 180k or 180000)`)
  const maxYoe = a.maxYoe ? Number(a.maxYoe) : null
  if (a.maxYoe && (maxYoe === null || !Number.isInteger(maxYoe) || maxYoe < 0)) throw new Error(`max years "${a.maxYoe}" must be a whole number`)
  if (!Number.isInteger(a.days) || a.days < 1) throw new Error(`days must be a positive whole number, got ${a.days}`)
  if (!["include", "only", "exclude"].includes(a.remote)) throw new Error(`remote must be include, only, or exclude, got "${a.remote}"`)
  const adzuna = !!(a.adzunaId && a.adzunaKey)
  if (a.adzunaId && !a.adzunaKey) notes.push("Adzuna app id given without a key — Adzuna left off; re-run init to add it")

  const existing = readExistingProfile()
  const profile = {
    cities: a.cities,
    preset: DEFAULT_PRESET.name,
    minTc,
    maxYoe,
    days: a.days,
    remote: a.remote,
    sources: ["greenhouse", "lever", "ashby", ...(adzuna ? ["adzuna"] : []), "freehire", ...(a.linkedin ? ["linkedin"] : [])],
    skills: a.skills,
    exclude: (existing.exclude as string[] | undefined) ?? DEFAULT_PRESET.exclude,
    linkedinAccepted: a.linkedin,
  }
  const profilePath = PROFILE_PATH()
  const envPath = adzuna ? ENV_PATH() : null
  const companiesPath = COMPANIES_PATH()
  const skillDirs = a.installSkill ? defaultSkillDirs() : []
  if (dryRun) {
    return { profilePath, envPath, companiesPath, seeded: companiesSeed.length, skillPaths: skillDirs.map((d) => join(d, "jobsweep", "SKILL.md")), notes, profile, dryRun: true }
  }

  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n")
  if (envPath) {
    const env = { ...readEnv(), ADZUNA_APP_ID: a.adzunaId, ADZUNA_APP_KEY: a.adzunaKey }
    writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n")
    chmodSync(envPath, 0o600)
  }
  if (!existsSync(companiesPath)) writeFileSync(companiesPath, JSON.stringify(companiesSeed, null, 2) + "\n")
  const skillPaths = skillDirs.length ? installSkill(skillDirs) : []
  return { profilePath, envPath, companiesPath, seeded: companiesSeed.length, skillPaths, notes, profile, dryRun: false }
}

/** Interactive setup. Re-runnable: existing values become the defaults. Never touches the repo. */
export async function init(): Promise<number> {
  const existing = readExistingProfile()
  const env = readEnv()
  out(`jobsweep setup — writes ${configDir()}`)
  out("Press Enter to keep the value in brackets. Nothing here leaves your machine.\n")

  const cities = ask("Cities (separate with ;  e.g. New York, NY; Austin, TX)", (existing.cities as string[] | undefined)?.join("; ") ?? "New York, NY")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  const minTc = ask("Comp floor (top of posted band must clear it; blank = none)", existing.minTc == null ? "" : String(existing.minTc))
  const maxYoe = ask("Max years of experience a posting may require (blank = any)", existing.maxYoe == null ? "" : String(existing.maxYoe))
  const days = Number(ask("Only postings from the last N days", String(existing.days ?? 14)))
  const remote = ask("Remote roles: include (city + remote), only, or exclude", String(existing.remote ?? "include"))
  const skills = ask("Skills to score postings against, comma-separated", ((existing.skills as string[] | undefined) ?? DEFAULT_PRESET.skills).join(", "))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  out("\nSources. Company boards (Greenhouse, Lever, Ashby), Adzuna and freehire use public or official APIs.")
  out(LINKEDIN_NOTICE)
  const linkedin = yes("Enable the LinkedIn connector for your own personal search?", existing.linkedinAccepted === true)

  out("\nAdzuna is a job aggregator with a free official API (https://developer.adzuna.com). Leave blank to skip it.")
  const adzunaId = ask("ADZUNA_APP_ID", env.ADZUNA_APP_ID ?? "")
  const adzunaKey = adzunaId ? ask("ADZUNA_APP_KEY", env.ADZUNA_APP_KEY ?? "") : ""

  const skillDirs = defaultSkillDirs()
  const install = yes(`\nInstall the jobsweep skill so your coding agent (Claude Code, Codex, Cursor, OMP…) runs jobsweep when you ask it to find or rank jobs? Writes SKILL.md under ${skillDirs.join(" and ")}`, true)

  let r: SetupResult
  try {
    r = writeSetup({ cities, minTc, maxYoe, days, remote, skills, linkedin, adzunaId, adzunaKey, installSkill: install })
  } catch (e) {
    out(`  ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  report(r)
  return 0
}

export function report(r: SetupResult): void {
  for (const n of r.notes) out(`  note: ${n}`)
  if (r.dryRun) {
    out(`Dry run — nothing written. Would write ${r.profilePath}${r.envPath ? ` and ${r.envPath} (Adzuna keys from the environment)` : ""}${r.skillPaths.length ? `, and the skill to ${r.skillPaths.join(", ")}` : ""}:`)
    out(JSON.stringify(r.profile, null, 2))
    return
  }
  out(`\nWrote ${r.profilePath}${r.envPath ? ` and ${r.envPath}` : ""}.`)
  out(`Company boards: ${r.companiesPath} (${r.seeded} seeded). Run \`jobsweep companies discover\` to add every board hiring in your cities — takes a couple of minutes.`)
  for (const p of r.skillPaths) out(`  installed ${p}`)
  out("Next: `jobsweep search`, then `jobsweep serve --open` for the dashboard — or just ask your agent to find jobs.")
  out("Want it to run by itself? `jobsweep schedule --daily 06:40` (or `--every 6h`).")
}
