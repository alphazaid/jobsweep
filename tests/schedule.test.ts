import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeCadence, install, LABEL, notify, parseCadence, remove, renderPlist, renderSystemd, schtasksArgs, status, UNIT } from "../src/schedule.ts"
import { absoluteLauncherArgv, resolveLauncherArgv } from "../src/skill.ts"

describe("cadence", () => {
  test("every: minutes, hours, days; floor at 15m", () => {
    expect(parseCadence("30m", undefined)).toEqual({ kind: "every", seconds: 1800 })
    expect(parseCadence("6h", undefined)).toEqual({ kind: "every", seconds: 21600 })
    expect(parseCadence("1d", undefined)).toEqual({ kind: "every", seconds: 86400 })
    expect(parseCadence("2 hr", undefined)).toEqual({ kind: "every", seconds: 7200 })
    expect(() => parseCadence("5m", undefined)).toThrow("at least 15m")
    expect(() => parseCadence("soon", undefined)).toThrow("--every wants")
  })
  test("daily: HH:MM validated; daily wins when both given", () => {
    expect(parseCadence("6h", "06:40")).toEqual({ kind: "daily", hour: 6, minute: 40 })
    expect(() => parseCadence(undefined, "25:00")).toThrow("HH:MM")
    expect(() => parseCadence(undefined, "6:4")).toThrow("HH:MM")
  })
  test("describe", () => {
    expect(describeCadence({ kind: "every", seconds: 21600 })).toBe("every 6h")
    expect(describeCadence({ kind: "every", seconds: 2700 })).toBe("every 45m")
    expect(describeCadence({ kind: "daily", hour: 6, minute: 5 })).toBe("daily at 06:05")
  })
})

describe("scheduler files", () => {
  const argv = ["/opt/homebrew/bin/bun", "run", "/Users/a b/src/cli.ts", "digest", "--notify"]
  test("launchd plist: absolute argv, interval or calendar, log paths, escaped", () => {
    const p = renderPlist(argv, { kind: "every", seconds: 21600 }, "/x/schedule.log", { PATH: "/a:/b", JOBSWEEP_HOME: "/h<me>" })
    expect(p).toContain(`<key>Label</key><string>${LABEL}</string>`)
    expect(p).toContain("<string>/Users/a b/src/cli.ts</string>")
    expect(p).toContain("<key>StartInterval</key><integer>21600</integer>")
    expect(p).toContain("<key>JOBSWEEP_HOME</key><string>/h&lt;me&gt;</string>")
    expect(p).toContain("<key>StandardErrorPath</key><string>/x/schedule.log</string>")
    const d = renderPlist(argv, { kind: "daily", hour: 6, minute: 40 }, "/x/l", {})
    expect(d).toContain("<key>Hour</key><integer>6</integer><key>Minute</key><integer>40</integer>")
    expect(d).not.toContain("StartInterval")
  })
  test("systemd: quoted ExecStart, timer forms", () => {
    const { service, timer } = renderSystemd(argv, { kind: "every", seconds: 3600 }, { PATH: "/a" })
    expect(service).toContain('ExecStart=/opt/homebrew/bin/bun run "/Users/a b/src/cli.ts" digest --notify')
    expect(service).toContain("Environment=PATH=/a")
    expect(timer).toContain("OnUnitActiveSec=3600s")
    expect(renderSystemd(argv, { kind: "daily", hour: 6, minute: 40 }, {}).timer).toContain("OnCalendar=*-*-* 06:40:00")
  })
  test("schtasks arguments", () => {
    expect(schtasksArgs(argv, { kind: "every", seconds: 21600 })).toEqual(["/Create", "/F", "/TN", UNIT, "/TR", '/opt/homebrew/bin/bun run "/Users/a b/src/cli.ts" digest --notify', "/SC", "MINUTE", "/MO", "360"])
    expect(schtasksArgs(["C:\\jobsweep.exe"], { kind: "daily", hour: 6, minute: 40 }).slice(-4)).toEqual(["/SC", "DAILY", "/ST", "06:40"])
  })
})

describe("launcher argv", () => {
  test("source checkout resolves bun and the entry absolutely; PATH binary resolves to its file", () => {
    const noPath = { PATH: "/nonexistent" }
    expect(resolveLauncherArgv(noPath, ["bun", "/repo/src/cli.ts"], "/usr/local/bin/bun")).toEqual(["/usr/local/bin/bun", "run", "/repo/src/cli.ts"])
    expect(resolveLauncherArgv(noPath, ["/opt/jobsweep"], "/opt/jobsweep")).toEqual(["/opt/jobsweep"])
    expect(absoluteLauncherArgv(noPath, ["/opt/jobsweep"], "/opt/jobsweep")).toEqual(["/opt/jobsweep"])
  })
})

describe("install / status / remove with an injected home and recorder", () => {
  test("macOS: writes the plist under the given home, boots out then bootstraps, removes cleanly", () => {
    const home = mkdtempSync(join(tmpdir(), "jobsweep-launchd-"))
    const calls: string[][] = []
    const run = (cmd: string[]) => (calls.push(cmd), { code: 0, out: "run interval = 21600" })
    const argv = ["/opt/homebrew/bin/bun", "run", "/repo/src/cli.ts", "digest", "--notify"]
    const r = install(argv, { kind: "every", seconds: 21600 }, { platform: "darwin", home, uid: 501, run })
    const plist = join(home, "Library", "LaunchAgents", `${LABEL}.plist`)
    expect(r.installed).toBe(plist)
    expect(readFileSync(plist, "utf8")).toContain("<key>StartInterval</key><integer>21600</integer>")
    expect(readFileSync(plist, "utf8")).toContain(`<key>HOME</key><string>${home}</string>`)
    expect(calls).toEqual([["launchctl", "bootout", `gui/501/${LABEL}`], ["launchctl", "bootstrap", "gui/501", plist]])
    expect(status({ platform: "darwin", uid: 501, run })).toEqual({ active: true, detail: "every 21600s" })
    expect(remove({ platform: "darwin", home, uid: 501, run })).toBe(plist)
    expect(existsSync(plist)).toBe(false)
    expect(calls.at(-1)).toEqual(["launchctl", "bootout", `gui/501/${LABEL}`])
    rmSync(home, { recursive: true, force: true })
  })
  test("macOS: a failing bootstrap surfaces launchctl's message", () => {
    const home = mkdtempSync(join(tmpdir(), "jobsweep-launchd-"))
    const run = (cmd: string[]) => (cmd[1] === "bootstrap" ? { code: 5, out: "Input/output error" } : { code: 0, out: "" })
    expect(() => install(["/x"], { kind: "daily", hour: 6, minute: 40 }, { platform: "darwin", home, uid: 501, run })).toThrow("Input/output error")
    rmSync(home, { recursive: true, force: true })
  })
  test("linux: writes service + timer under XDG config, enables the timer", () => {
    const home = mkdtempSync(join(tmpdir(), "jobsweep-systemd-"))
    const calls: string[][] = []
    const run = (cmd: string[]) => (calls.push(cmd), { code: 0, out: "" })
    const prev = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    const r = install(["/usr/local/bin/jobsweep", "digest", "--notify"], { kind: "daily", hour: 6, minute: 40 }, { platform: "linux", home, run })
    const dir = join(home, ".config", "systemd", "user")
    expect(r.installed).toBe(join(dir, `${UNIT}.timer`))
    expect(readFileSync(join(dir, `${UNIT}.timer`), "utf8")).toContain("OnCalendar=*-*-* 06:40:00")
    expect(readFileSync(join(dir, `${UNIT}.service`), "utf8")).toContain("ExecStart=/usr/local/bin/jobsweep digest --notify")
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${UNIT}.timer`]])
    remove({ platform: "linux", home, run })
    expect(existsSync(join(dir, `${UNIT}.service`))).toBe(false)
    if (prev !== undefined) process.env.XDG_CONFIG_HOME = prev
    rmSync(home, { recursive: true, force: true })
  })
  test("windows: schtasks create / query / delete", () => {
    const calls: string[][] = []
    const run = (cmd: string[]) => (calls.push(cmd), { code: 0, out: "jobsweep-digest  Ready" })
    install(["C:\\Tools\\jobsweep.exe", "digest", "--notify"], { kind: "every", seconds: 3600 }, { platform: "win32", run })
    expect(calls[0]!.slice(0, 5)).toEqual(["schtasks", "/Create", "/F", "/TN", UNIT])
    expect(status({ platform: "win32", run }).active).toBe(true)
    remove({ platform: "win32", run })
    expect(calls.at(-1)).toEqual(["schtasks", "/Delete", "/F", "/TN", UNIT])
  })
  test("notify: macOS uses osascript with quoted text; unsupported platforms are silent", () => {
    const calls: string[][] = []
    const run = (cmd: string[]) => (calls.push(cmd), { code: 0, out: "" })
    notify("jobsweep", '3 new "postings"', "darwin", run)
    expect(calls[0]).toEqual(["osascript", "-e", 'display notification "3 new \\"postings\\"" with title "jobsweep"'])
    notify("jobsweep", "x", "freebsd", run)
    expect(calls.length).toBe(1)
  })
})
