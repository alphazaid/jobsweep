#!/usr/bin/env bun
// Builds self-contained executables (no Bun needed on the target) into dist/.
// `bun run build` → all targets; `bun run scripts/build.ts darwin-arm64` → one.
import { mkdirSync } from "node:fs"
import pkg from "../package.json"

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-windows-x64"] as const
const only = process.argv[2]
const targets = only ? TARGETS.filter((t) => t.endsWith(only)) : [...TARGETS]
if (!targets.length) {
  console.error(`unknown target "${only}"; choose one of ${TARGETS.map((t) => t.slice(4)).join(", ")}`)
  process.exit(1)
}
mkdirSync("dist", { recursive: true })
for (const target of targets) {
  const out = `dist/jobsweep-${pkg.version}-${target.slice(4)}${target.includes("windows") ? ".exe" : ""}`
  const r = Bun.spawnSync(["bun", "build", "--compile", "--minify", `--target=${target}`, "src/cli.ts", "--outfile", out])
  if (r.exitCode !== 0) {
    console.error(r.stderr.toString())
    process.exit(r.exitCode)
  }
  console.log(`built ${out}`)
}
