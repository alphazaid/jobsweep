import skillTemplate from "../skill/SKILL.md" with { type: "text" }
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

/**
 * How the installed skill should invoke the CLI. `jobsweep` when it's on PATH; otherwise the absolute path of
 * whatever is running now — the compiled binary, or `bun run /abs/src/cli.ts` from a source checkout — so the
 * commands the skill hands to the agent work on this machine without further setup.
 */
export function resolveLauncher(env = process.env, argv = process.argv, execPath = process.execPath): string {
  if (Bun.which("jobsweep", { PATH: env.PATH }) !== null) return "jobsweep"
  const entry = argv[1]
  if (entry && entry.endsWith(".ts")) return `bun run ${shellQuote(resolve(entry))}`
  return basename(execPath).startsWith("jobsweep") ? shellQuote(resolve(execPath)) : "jobsweep"
}

/** Paths go into shell code blocks the agent will run verbatim; anything beyond plain path characters is single-quoted. */
export function shellQuote(path: string): string {
  return /^[A-Za-z0-9_\/.:+@%-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`
}

/** The skill with a concrete launcher filled in. `allowed-tools` wants the bare executable name. */
export function renderSkill(launcher: string): string {
  const tool = launcher.startsWith("bun ") ? "bun" : basename(launcher.replace(/^'|'$/g, ""))
  return skillTemplate.replaceAll("{{JOBSWEEP}}", launcher).replaceAll("{{JOBSWEEP_TOOL}}", tool)
}

/**
 * Where coding agents look for user-level skills. `~/.agents/skills` is the cross-client convention
 * (agentskills.io); `~/.claude/skills` is Claude Code's native location and is used only when it already exists.
 */
export function defaultSkillDirs(home = homedir()): string[] {
  const dirs = [join(home, ".agents", "skills")]
  if (existsSync(join(home, ".claude"))) dirs.push(join(home, ".claude", "skills"))
  return dirs
}

/** Write the rendered SKILL.md into `<dir>/jobsweep/` for each dir (defaults above). Returns the paths written. */
export function installSkill(dirs?: string[], launcher = resolveLauncher()): string[] {
  const targets = dirs?.length ? dirs : defaultSkillDirs()
  const text = renderSkill(launcher)
  return targets.map((d) => {
    const skillDir = join(d, "jobsweep")
    mkdirSync(skillDir, { recursive: true })
    const path = join(skillDir, "SKILL.md")
    writeFileSync(path, text)
    return path
  })
}
