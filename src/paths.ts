import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Everything user-specific lives in one directory, never in the repo or the binary:
 *   profile.json    standing search preferences (from `jobsweep init`)
 *   companies.json  company boards to poll (seeded, extended by `companies discover`)
 *   metros.json     optional extra city aliases, merged over the built-in table
 *   .env            ADZUNA_APP_ID / ADZUNA_APP_KEY
 *   jobsweep.db     seen postings + feed cache
 *   digests/        digest output; ui/ the triage pages
 * Location: $JOBSWEEP_HOME, else $XDG_CONFIG_HOME/jobsweep, else ~/.config/jobsweep.
 */
export function configDir(): string {
  const dir = process.env.JOBSWEEP_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "jobsweep")
  mkdirSync(dir, { recursive: true })
  return dir
}

export const PROFILE_PATH = () => join(configDir(), "profile.json")
export const COMPANIES_PATH = () => join(configDir(), "companies.json")
export const USER_METROS_PATH = () => join(configDir(), "metros.json")
export const ENV_PATH = () => join(configDir(), ".env")
export const DB_PATH = () => process.env.JOBSWEEP_DB ?? join(configDir(), "jobsweep.db")
export const DIGEST_DIR = () => join(configDir(), "digests")
export const UI_DIR = () => join(configDir(), "ui")
export const CANDIDATE_PATH = () => join(configDir(), "candidate.md")
