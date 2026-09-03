// `jobsweep doctor`: is this machine set up? One line per check, exit 1 if anything required is missing.
// Written for an agent following SETUP.md as much as for a person: --json gives the same checks as data.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import companiesSeed from "../companies.seed.json"
import { Store } from "./db.ts"
import { COMPANIES_PATH, DB_PATH, DIGEST_DIR, ENV_PATH, PROFILE_PATH, configDir } from "./paths.ts"
import { loadProfile } from "./profile.ts"
import { status as scheduleStatus } from "./schedule.ts"
import { defaultSkillDirs } from "./skill.ts"
import { readLastSearch } from "./serve.ts"

export interface Check {
  name: string
  ok: boolean
  /** Required for the tool to work at all; optional checks only inform. */
  required: boolean
  detail: string
  fix?: string
}

export async function doctor(): Promise<Check[]> {
  const checks: Check[] = []
  const dir = configDir()

  const profile = existsSync(PROFILE_PATH()) ? await loadProfile(PROFILE_PATH()).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : null
  if (profile instanceof Error) checks.push({ name: "profile", ok: false, required: true, detail: `${PROFILE_PATH()}: ${profile.message}`, fix: "jobsweep init" })
  else if (!profile) checks.push({ name: "profile", ok: false, required: true, detail: `${PROFILE_PATH()} missing`, fix: "jobsweep init --cities \"City, ST\" ..." })
  else checks.push({ name: "profile", ok: true, required: true, detail: `${profile.cities.join(" / ")} · ${profile.minTc == null ? "any comp" : `≥ $${Math.round(profile.minTc / 1000)}k`} · ${profile.maxYoe == null ? "any yrs" : `≤ ${profile.maxYoe} yrs`} · sources ${profile.sources.join(",")}` })

  const companies = existsSync(COMPANIES_PATH()) ? (JSON.parse(readFileSync(COMPANIES_PATH(), "utf8")) as unknown[]) : null
  if (!companies) checks.push({ name: "companies", ok: false, required: true, detail: `${COMPANIES_PATH()} missing`, fix: "jobsweep init" })
  else checks.push({ name: "companies", ok: companies.length > 0, required: true, detail: `${companies.length} boards${companies.length <= companiesSeed.length ? " (the seed list — `jobsweep companies discover` adds boards hiring in your cities)" : ""}` })

  if (existsSync(ENV_PATH())) {
    const mode = statSync(ENV_PATH()).mode & 0o777
    const keys = readFileSync(ENV_PATH(), "utf8").split("\n").map((l) => l.split("=")[0]!.trim()).filter(Boolean)
    checks.push({ name: "env", ok: mode === 0o600 || process.platform === "win32", required: false, detail: `${ENV_PATH()} · keys: ${keys.join(", ") || "none"} · mode ${mode.toString(8)}`, fix: mode === 0o600 ? undefined : `chmod 600 ${ENV_PATH()}` })
    checks.push({ name: "adzuna", ok: keys.includes("ADZUNA_APP_ID") && keys.includes("ADZUNA_APP_KEY"), required: false, detail: keys.includes("ADZUNA_APP_ID") ? "keys present" : "not configured (optional; free key at https://developer.adzuna.com)" })
    checks.push({ name: "model", ok: keys.some((k) => k === "OPENAI_API_KEY" || k === "ANTHROPIC_API_KEY"), required: false, detail: keys.some((k) => k === "OPENAI_API_KEY" || k === "ANTHROPIC_API_KEY") ? "key present (interview/rank available)" : "no model key (optional; your agent can rank via `jobsweep review` instead)" })
  } else {
    checks.push({ name: "env", ok: true, required: false, detail: `${ENV_PATH()} absent (fine: no Adzuna or model key)` })
  }

  const skillDirs = defaultSkillDirs()
  const installed = skillDirs.map((d) => join(d, "jobsweep", "SKILL.md")).filter((p) => existsSync(p))
  const stale = installed.filter((p) => readFileSync(p, "utf8").includes("{{JOBSWEEP}}"))
  checks.push({ name: "skill", ok: installed.length > 0 && stale.length === 0, required: false, detail: installed.length ? `${installed.join(", ")}${stale.length ? " — STALE (placeholders unfilled)" : ""}` : `not installed (${skillDirs.join(", ")})`, fix: installed.length && !stale.length ? undefined : "jobsweep skill --install" })

  const last = await readLastSearch()
  checks.push({ name: "search", ok: !!last, required: false, detail: last ? `last search ${last.date}: ${last.jobs.length} open` : "no search yet", fix: last ? undefined : "jobsweep search" })

  if (existsSync(DB_PATH())) {
    const store = new Store()
    const runs = store.runs()
    store.close()
    checks.push({ name: "database", ok: true, required: false, detail: `${DB_PATH()} · ${runs.length} run${runs.length === 1 ? "" : "s"} recorded` })
  } else checks.push({ name: "database", ok: true, required: false, detail: "created on first search" })

  const sched = scheduleStatus()
  checks.push({ name: "schedule", ok: true, required: false, detail: sched.active ? `scheduled · ${sched.detail}` : "not scheduled (optional: jobsweep schedule --daily 06:40)" })

  checks.push({ name: "config dir", ok: existsSync(dir), required: true, detail: `${dir}${process.env.JOBSWEEP_HOME ? " (JOBSWEEP_HOME)" : ""} · digests in ${DIGEST_DIR()} · home ${homedir()}` })
  return checks
}

export function renderChecks(checks: Check[]): string {
  const w = Math.max(...checks.map((c) => c.name.length))
  return checks.map((c) => `${c.ok ? "ok  " : c.required ? "FAIL" : "--  "} ${c.name.padEnd(w)}  ${c.detail}${!c.ok && c.fix ? `\n${" ".repeat(w + 6)}fix: ${c.fix}` : ""}`).join("\n") + "\n"
}
