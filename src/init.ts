import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import companiesSeed from "../companies.seed.json"
import { knownMetro } from "./filters.ts"
import { COMPANIES_PATH, ENV_PATH, PROFILE_PATH, configDir } from "./paths.ts"
import { LINKEDIN_NOTICE, parseMoney } from "./profile.ts"
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

/**
 * Walks the user through a profile and writes it to the config dir. Re-runnable:
 * existing values become the defaults. Never touches the repo.
 */
export async function init(): Promise<number> {
  const dir = configDir()
  const profilePath = PROFILE_PATH()
  const existing: Record<string, unknown> = existsSync(profilePath) ? JSON.parse(readFileSync(profilePath, "utf8")) : {}
  out(`jobsweep setup — writes ${dir}`)
  out("Press Enter to keep the value in brackets. Nothing here leaves your machine.\n")

  const cities = ask("Cities, comma-separated (e.g. New York, NY; Austin, TX — separate with ;)", (existing.cities as string[] | undefined)?.join("; ") ?? "New York, NY")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
  for (const c of cities) if (!knownMetro(c)) out(`  note: no suburb aliases for "${c}" yet — only exact city text matches. Add some to ${dir}/metros.json if you want (see README).`)

  const minTcRaw = ask("Comp floor (top of posted band must clear it; blank = none)", existing.minTc == null ? "" : String(existing.minTc))
  const minTc = minTcRaw ? parseMoney(minTcRaw) : null
  if (minTcRaw && minTc === null) {
    out("  that isn't a number I understand (try 180k or 180000)")
    return 1
  }
  const maxYoeRaw = ask("Max years of experience a posting may require (blank = any)", existing.maxYoe == null ? "" : String(existing.maxYoe))
  const days = Number(ask("Only postings from the last N days", String(existing.days ?? 14)))
  const remote = ask("Remote roles: include (city + remote), only, or exclude", String(existing.remote ?? "include"))
  const skills = ask("Skills to score postings against, comma-separated", ((existing.skills as string[] | undefined) ?? DEFAULT_PRESET.skills).join(", "))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  out("\nSources. Company boards (Greenhouse, Lever, Ashby), Adzuna and freehire use public or official APIs.")
  out(LINKEDIN_NOTICE)
  const linkedin = yes("Enable the LinkedIn connector for your own personal search?", existing.linkedinAccepted === true)
  const sources = ["greenhouse", "lever", "ashby", "adzuna", "freehire", ...(linkedin ? ["linkedin"] : [])]

  const envPath = ENV_PATH()
  const env: Record<string, string> = {}
  if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]!] = m[2]! }
  out("\nAdzuna is a job aggregator with a free official API (https://developer.adzuna.com). Leave blank to skip it.")
  const adzId = ask("ADZUNA_APP_ID", env.ADZUNA_APP_ID ?? "")
  const adzKey = adzId ? ask("ADZUNA_APP_KEY", env.ADZUNA_APP_KEY ?? "") : ""

  const profile = {
    cities,
    preset: DEFAULT_PRESET.name,
    minTc: minTc === null ? null : minTc,
    maxYoe: maxYoeRaw ? Number(maxYoeRaw) : null,
    days,
    remote,
    sources,
    skills,
    exclude: (existing.exclude as string[] | undefined) ?? DEFAULT_PRESET.exclude,
    linkedinAccepted: linkedin,
  }
  writeFileSync(profilePath, JSON.stringify(profile, null, 2) + "\n")
  if (adzId) {
    writeFileSync(envPath, `ADZUNA_APP_ID=${adzId}\nADZUNA_APP_KEY=${adzKey}\n`)
    chmodSync(envPath, 0o600)
  }
  const companiesPath = COMPANIES_PATH()
  if (!existsSync(companiesPath)) writeFileSync(companiesPath, JSON.stringify(companiesSeed, null, 2) + "\n")

  out(`\nWrote ${profilePath}${adzId ? ` and ${envPath}` : ""}.`)
  out(`Company boards: ${companiesPath} (${companiesSeed.length} seeded). Run \`jobsweep companies discover\` to add every board hiring in your cities — takes a couple of minutes.`)
  out("Next: `jobsweep search`, then `jobsweep ui --open` to triage.")
  return 0
}
