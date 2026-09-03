// `jobsweep schedule`: run the digest on a timer using what the OS already has —
// launchd on macOS, a systemd user timer on Linux, Task Scheduler on Windows.
// Nothing of ours stays resident; the OS wakes the CLI, it runs, it exits.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DIGEST_DIR } from "./paths.ts"

export type Cadence = { kind: "every"; seconds: number } | { kind: "daily"; hour: number; minute: number }

/** "30m", "6h", "1d" → seconds; "06:40" → daily at that time. */
export function parseCadence(every: string | undefined, daily: string | undefined): Cadence {
  if (daily !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(daily)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`--daily wants HH:MM (24h), got "${daily}"`)
    return { kind: "daily", hour: Number(m[1]), minute: Number(m[2]) }
  }
  const m = /^(\d+)\s*(m|min|h|hr|d)$/i.exec(every ?? "")
  if (!m) throw new Error(`--every wants a number and unit like 30m, 6h, 1d, got "${every ?? ""}"`)
  const n = Number(m[1])
  const unit = m[2]!.toLowerCase()
  const seconds = unit.startsWith("m") ? n * 60 : unit.startsWith("h") ? n * 3600 : n * 86400
  if (seconds < 15 * 60) throw new Error("--every must be at least 15m: the sources are shared and the sweep itself takes a minute")
  return { kind: "every", seconds }
}

export function describeCadence(c: Cadence): string {
  if (c.kind === "daily") return `daily at ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`
  const s = c.seconds
  return `every ${s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${s / 60}m`}`
}

export const LABEL = "com.jobsweep.digest"
export const UNIT = "jobsweep-digest"

const xml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)

/** launchd property list. `argv` is absolute: launchd runs with a minimal PATH. */
export function renderPlist(argv: string[], c: Cadence, logPath: string, env: Record<string, string>): string {
  const trigger =
    c.kind === "every"
      ? `<key>StartInterval</key><integer>${c.seconds}</integer>`
      : `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${c.hour}</integer><key>Minute</key><integer>${c.minute}</integer></dict>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  ${trigger}
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
`
}

/** systemd user unit + timer. */
export function renderSystemd(argv: string[], c: Cadence, env: Record<string, string>): { service: string; timer: string } {
  const q = (a: string) => (/^[A-Za-z0-9_\/.:+@%=-]+$/.test(a) ? a : `"${a.replace(/(["\\$])/g, "\\$1")}"`)
  const service = `[Unit]
Description=jobsweep digest

[Service]
Type=oneshot
ExecStart=${argv.map(q).join(" ")}
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n")}
`
  const on = c.kind === "every" ? `OnBootSec=5min\nOnUnitActiveSec=${c.seconds}s` : `OnCalendar=*-*-* ${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}:00\nPersistent=true`
  const timer = `[Unit]
Description=jobsweep digest (${describeCadence(c)})

[Timer]
${on}

[Install]
WantedBy=timers.target
`
  return { service, timer }
}

/** schtasks arguments (Windows). */
export function schtasksArgs(argv: string[], c: Cadence): string[] {
  const tr = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")
  const when = c.kind === "every" ? ["/SC", "MINUTE", "/MO", String(Math.max(1, Math.round(c.seconds / 60)))] : ["/SC", "DAILY", "/ST", `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`]
  return ["/Create", "/F", "/TN", UNIT, "/TR", tr, ...when]
}

type Runner = (cmd: string[]) => { code: number; out: string }

/** Runs a scheduler command; tests inject a recorder so nothing touches launchd/systemd/schtasks. */
const runSh: Runner = (cmd) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
  return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() }
}

export interface SchedulerEnv {
  platform?: NodeJS.Platform
  home?: string
  uid?: number
  run?: Runner
}

function envOf(e: SchedulerEnv) {
  return { platform: e.platform ?? process.platform, home: e.home ?? homedir(), uid: e.uid ?? process.getuid?.() ?? 0, sh: e.run ?? runSh }
}

function envFor(home: string): Record<string, string> {
  const env: Record<string, string> = { PATH: ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.bun/bin`, "/usr/bin", "/bin"].join(":"), HOME: home }
  if (process.env.JOBSWEEP_HOME) env.JOBSWEEP_HOME = process.env.JOBSWEEP_HOME
  return env
}

export interface ScheduleResult {
  installed: string
  runs: string
  log: string
}

/** Install (or replace) the digest timer for this OS. `argv` is the absolute launcher argv plus `digest --notify`. */
export function install(argv: string[], c: Cadence, e: SchedulerEnv = {}): ScheduleResult {
  const { platform, home, uid, sh } = envOf(e)
  mkdirSync(DIGEST_DIR(), { recursive: true })
  const log = join(DIGEST_DIR(), "schedule.log")
  if (platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true })
    writeFileSync(plist, renderPlist(argv, c, log, envFor(home)))
    const domain = `gui/${uid}`
    sh(["launchctl", "bootout", `${domain}/${LABEL}`]) // replace if present; harmless when absent
    const r = sh(["launchctl", "bootstrap", domain, plist])
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.out}`)
    return { installed: plist, runs: describeCadence(c), log }
  }
  if (platform === "linux") {
    const dir = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user")
    mkdirSync(dir, { recursive: true })
    const { service, timer } = renderSystemd(argv, c, envFor(home))
    writeFileSync(join(dir, `${UNIT}.service`), service)
    writeFileSync(join(dir, `${UNIT}.timer`), timer)
    for (const cmd of [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${UNIT}.timer`]]) {
      const r = sh(cmd)
      if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.out}`)
    }
    return { installed: join(dir, `${UNIT}.timer`), runs: describeCadence(c), log: `journalctl --user -u ${UNIT}` }
  }
  if (platform === "win32") {
    const r = sh(["schtasks", ...schtasksArgs(argv, c)])
    if (r.code !== 0) throw new Error(`schtasks failed: ${r.out}`)
    return { installed: `Task Scheduler: ${UNIT}`, runs: describeCadence(c), log }
  }
  throw new Error(`no scheduler support for ${platform}; run \`jobsweep digest\` from cron`)
}

export function remove(e: SchedulerEnv = {}): string {
  const { platform, home, uid, sh } = envOf(e)
  if (platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    sh(["launchctl", "bootout", `gui/${uid}/${LABEL}`])
    if (existsSync(plist)) rmSync(plist)
    return plist
  }
  if (platform === "linux") {
    const dir = join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user")
    sh(["systemctl", "--user", "disable", "--now", `${UNIT}.timer`])
    for (const f of [`${UNIT}.timer`, `${UNIT}.service`]) if (existsSync(join(dir, f))) rmSync(join(dir, f))
    sh(["systemctl", "--user", "daemon-reload"])
    return join(dir, `${UNIT}.timer`)
  }
  if (platform === "win32") {
    sh(["schtasks", "/Delete", "/F", "/TN", UNIT])
    return `Task Scheduler: ${UNIT}`
  }
  throw new Error(`no scheduler support for ${platform}`)
}

export function status(e: SchedulerEnv = {}): { active: boolean; detail: string } {
  const { platform, uid, sh } = envOf(e)
  if (platform === "darwin") {
    const r = sh(["launchctl", "print", `gui/${uid}/${LABEL}`])
    if (r.code !== 0) return { active: false, detail: "not installed" }
    const runs = /run interval = (\d+)|calendar/i.exec(r.out)
    const last = /last exit code = (\S+)/.exec(r.out)
    return { active: true, detail: `${runs?.[1] ? `every ${runs[1]}s` : "on a calendar"}${last ? ` · last exit ${last[1]}` : ""}` }
  }
  if (platform === "linux") {
    const r = sh(["systemctl", "--user", "list-timers", `${UNIT}.timer`, "--no-pager", "--no-legend"])
    return r.code === 0 && r.out.includes(UNIT) ? { active: true, detail: r.out } : { active: false, detail: "not installed" }
  }
  if (platform === "win32") {
    const r = sh(["schtasks", "/Query", "/TN", UNIT])
    return r.code === 0 ? { active: true, detail: r.out.split("\n").slice(-1)[0] ?? "" } : { active: false, detail: "not installed" }
  }
  return { active: false, detail: `unsupported platform ${platform}` }
}

/** Desktop notification after a scheduled digest, where the OS offers one. Silent no-op elsewhere. */
export function notify(title: string, body: string, platform = process.platform, sh: Runner = runSh): void {
  if (platform === "darwin") {
    sh(["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`])
  } else if (platform === "linux" && Bun.which("notify-send")) {
    sh(["notify-send", title, body])
  }
}

