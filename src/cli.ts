#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import companiesSeed from "../companies.seed.json"
import pkg from "../package.json"
import { Store } from "./db.ts"
import { discoverBoards } from "./discover.ts"
import { matchedLocation } from "./filters.ts"
import { pool } from "./http.ts"
import { init } from "./init.ts"
import { FORMATS, render, renderDigest, sortByPay, type Format, type Report } from "./output.ts"
import { COMPANIES_PATH, DIGEST_DIR, PROFILE_PATH, UI_DIR, configDir } from "./paths.ts"
import { loadEnv, loadProfile, parseMoney, type Profile } from "./profile.ts"
import { PROVIDERS } from "./providers/index.ts"
import type { ProviderCtx } from "./providers/provider.ts"
import { run } from "./run.ts"
import { AGENCY_RE, ALL_SOURCES, DEFAULT_QUERIES, LEVELS, SWE_TITLE_RE, type Company, type Job, type Level, type SearchParams, type Source } from "./types.ts"
import { renderUi } from "./ui.ts"

const HELP = `jobsweep ${pkg.version} — sweep company boards, Adzuna, freehire (and optionally LinkedIn) for software jobs by city, comp, and experience

USAGE
  jobsweep init                       Set up your profile (cities, comp floor, years, skills, sources, Adzuna key).
  jobsweep search [flags]             Search. Flags override the profile; with a profile, no flags needed.
  jobsweep ui [--open]                Build a one-file triage page from the last search and optionally open it.
  jobsweep digest [--top <n>]         Run the profile, write digests/<date>.md + latest.json, print the digest.
  jobsweep detail <id>                Full posting JSON (e.g. greenhouse:stripe:7532733, linkedin:4300011451).
  jobsweep companies [--verify]       List company boards; --verify hits each one live.
  jobsweep companies discover         Add every Greenhouse/Lever/Ashby board hiring in your cities (via freehire).
  jobsweep cache [clear]              Show cache size, or drop cached feeds.

Config lives in ${configDir()} (override with JOBSWEEP_HOME): profile.json, companies.json, metros.json, .env, jobsweep.db, digests/, ui/

SEARCH FLAGS
  -l, --city <text>        City. Repeatable. Required unless the profile sets cities.
  -q, --query <text>       Keyword search. Repeatable. Default: the preset's queries.
  --title-re <regex>       Title gate (default: SWE preset). Every result's title must match.
  --min-tc <usd>           Comp floor, e.g. 180000 or 180k, compared to the TOP of the posted band. Postings
                           without stated comp are kept in a separate section (see --strict-comp).
  --strict-comp            Drop postings that state no comp.
  --max-yoe <n>            Drop postings requiring more than n years (unstated → title band:
                           entry 0, mid 2, senior 5, staff/principal/lead/manager 8).
  --level <list>           intern,entry,mid,senior,staff
  --remote <mode>          include (default: city + remote-US) | only | exclude
  --days <n>               Posted within n days. Company-board postings older than 90 days are never returned.
  --sources <list>         Subset of: ${ALL_SOURCES.join(",")}
  --linkedin               Enable the LinkedIn connector for this run (personal use; see \`jobsweep init\`).
  --per-source <n>         Results per query per source before filtering (default 50).
  --no-hydrate             Skip LinkedIn detail pages (faster; no comp/years/fit for those rows).
  --new                    Only postings not seen in a previous run.
  -f, --format <fmt>       table (default) | plain | md | json
  --limit <n>              Cap rows per section.

EXAMPLES
  jobsweep search
  jobsweep search -l "Austin, TX" --min-tc 160k --max-yoe 4 --days 7
  jobsweep search -l "Remote" --remote only -q "backend engineer" -f md
  jobsweep ui --open
`

function fail(error: string, code: string): never {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
  process.exit(1)
}

function int(name: string, raw: string): number {
  const n = parseInt(raw, 10)
  if (Number.isNaN(n) || n < 0) fail(`--${name} must be a non-negative integer, got "${raw}"`, "BAD_ARG")
  return n
}

async function loadCompanies(path: string): Promise<Company[]> {
  const f = Bun.file(path)
  const list = (await f.exists()) ? ((await f.json()) as Company[]) : (companiesSeed as Company[])
  // Agency/aggregator boards repost thousands of jobs; a file written before discovery filtered them may still list some.
  const agencies = list.filter((c) => AGENCY_RE.test(c.name) || AGENCY_RE.test(c.slug))
  if (agencies.length) process.stderr.write(`# skipping ${agencies.length} agency board(s) in ${path}: ${agencies.map((c) => c.slug).join(", ")}\n`)
  return list.filter((c) => !agencies.includes(c))
}

function makeCtx(companies: Company[], store: Store): ProviderCtx {
  return { companies, cache: store, retire: (id) => store.remove(id), log: (m) => process.stderr.write(`# ${m}\n`) }
}

/** Per-city SearchParams from a profile; `over` wins field-by-field. */
function paramsFor(profile: Profile | null, over: Partial<SearchParams> & { cities?: string[] }): SearchParams[] {
  const cities = over.cities?.length ? over.cities : (profile?.cities ?? [])
  if (!cities.length) fail('--city/-l is required (e.g. -l "New York, NY"), or run `jobsweep init`', "NO_CITY")
  const base: Omit<SearchParams, "city"> = {
    queries: over.queries?.length ? over.queries : (profile?.queries ?? DEFAULT_QUERIES),
    titleRe: over.titleRe ?? profile?.titleRe ?? SWE_TITLE_RE,
    remote: over.remote ?? profile?.remote ?? "include",
    minTc: over.minTc !== undefined ? over.minTc : (profile?.minTc ?? null),
    maxYoe: over.maxYoe !== undefined ? over.maxYoe : (profile?.maxYoe ?? null),
    levels: over.levels !== undefined ? over.levels : (profile?.levels ?? null),
    days: over.days !== undefined ? over.days : (profile?.days ?? null),
    sources: over.sources ?? profile?.sources ?? ALL_SOURCES.filter((s) => s !== "linkedin"),
    perSource: over.perSource ?? 50,
    hydrate: over.hydrate ?? true,
    linkedinAccepted: over.linkedinAccepted ?? profile?.linkedinAccepted ?? false,
  }
  return cities.map((city) => ({ ...base, city }))
}

const SEARCH_OPTIONS = {
  city: { type: "string", short: "l", multiple: true },
  query: { type: "string", short: "q", multiple: true },
  "title-re": { type: "string" },
  "min-tc": { type: "string" },
  "strict-comp": { type: "boolean", default: false },
  "max-yoe": { type: "string" },
  level: { type: "string" },
  remote: { type: "string" },
  days: { type: "string" },
  sources: { type: "string" },
  linkedin: { type: "boolean", default: false },
  companies: { type: "string" },
  profile: { type: "string" },
  "per-source": { type: "string" },
  hydrate: { type: "boolean", default: true },
  new: { type: "boolean", default: false },
  format: { type: "string", short: "f", default: "table" },
  limit: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const

function parseSearchArgs(argv: string[]) {
  try {
    return parseArgs({ args: argv, strict: true, allowNegative: true, options: SEARCH_OPTIONS }).values
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "UNKNOWN_FLAG")
  }
}

async function search(argv: string[]): Promise<number> {
  const v = parseSearchArgs(argv)
  if (v.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (v.remote !== undefined && !["include", "only", "exclude"].includes(v.remote)) fail(`--remote must be include|only|exclude`, "BAD_ARG")
  const fmt = v.format as Format
  if (!FORMATS.includes(fmt)) fail(`--format must be one of ${FORMATS.join("|")}`, "BAD_ARG")
  const levels = v.level ? (v.level.split(",").map((s) => s.trim()) as Level[]) : undefined
  for (const l of levels ?? []) if (!LEVELS.includes(l)) fail(`--level values must be in ${LEVELS.join(",")}`, "BAD_ARG")
  let sources = v.sources ? (v.sources.split(",").map((s) => s.trim()) as Source[]) : undefined
  for (const s of sources ?? []) if (!ALL_SOURCES.includes(s)) fail(`--sources values must be in ${ALL_SOURCES.join(",")}`, "BAD_ARG")
  if (v.linkedin && sources && !sources.includes("linkedin")) sources = [...sources, "linkedin"]
  let minTc: number | null | undefined
  if (v["min-tc"] !== undefined) {
    minTc = parseMoney(v["min-tc"])
    if (minTc === null) fail(`--min-tc must look like 180000 or 180k, got "${v["min-tc"]}"`, "BAD_ARG")
  }
  let titleRe: RegExp | undefined
  if (v["title-re"] !== undefined) {
    try {
      titleRe = new RegExp(v["title-re"], "i")
    } catch (e) {
      fail(`--title-re is not a valid regex: ${e instanceof Error ? e.message : e}`, "BAD_ARG")
    }
  }

  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  if (v.linkedin && !sources && profile && !profile.sources.includes("linkedin")) sources = [...profile.sources, "linkedin"]
  const params = paramsFor(profile, {
    cities: v.city,
    queries: v.query,
    titleRe,
    remote: v.remote as SearchParams["remote"] | undefined,
    minTc,
    maxYoe: v["max-yoe"] !== undefined ? int("max-yoe", v["max-yoe"]) : undefined,
    levels,
    days: v.days !== undefined ? int("days", v.days) : undefined,
    sources,
    perSource: v["per-source"] !== undefined ? int("per-source", v["per-source"]) : undefined,
    hydrate: v.hydrate,
    linkedinAccepted: v.linkedin ? true : undefined,
  })
  const limit = v.limit !== undefined ? int("limit", v.limit) : null

  const store = new Store()
  const result = await run(params, profile ?? { skills: [], exclude: [] }, makeCtx(await loadCompanies(v.companies ?? COMPANIES_PATH()), store), store)
  store.close()

  let shown = v.new ? result.jobs.filter((j) => result.newIds[j.id]) : result.jobs
  if (v["strict-comp"]) shown = shown.filter((j) => j.salary)
  const matches = shown.filter((j) => j.salary)
  const unknownComp = shown.filter((j) => !j.salary)
  const report: Report = {
    params: { ...params[0], titleRe: params[0]!.titleRe.source, cities: params.map((p) => p.city), strictComp: v["strict-comp"], onlyNew: v.new },
    dropped: result.dropped,
    errors: result.errors,
    matches: limit === null ? matches : matches.slice(0, limit),
    unknownComp: limit === null ? unknownComp : unknownComp.slice(0, limit),
    newIds: result.newIds,
    carriedIds: result.carriedIds,
  }
  process.stdout.write(render(report, fmt) + "\n")
  // The UI and digest build from the last search.
  mkdirSync(DIGEST_DIR(), { recursive: true })
  await Bun.write(join(DIGEST_DIR(), "last-search.json"), JSON.stringify({ date: new Date().toISOString().slice(0, 10), params: report.params, jobs: result.jobs, carriedIds: Object.keys(result.carriedIds) }))
  return 0
}

interface LastSearch {
  date: string
  params: { cities: string[]; minTc: number | null; maxYoe: number | null; days: number | null }
  jobs: Job[]
}

async function ui(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { open: { type: "boolean", default: false }, out: { type: "string" }, profile: { type: "string" } } })
  const lastPath = join(DIGEST_DIR(), "last-search.json")
  if (!existsSync(lastPath)) fail("no search yet — run `jobsweep search` first", "NO_SEARCH")
  const last = (await Bun.file(lastPath).json()) as LastSearch
  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  const cities = last.params.cities
  const cityParams = cities.map((city) => ({ city, remote: "exclude" as const }))
  const fmtTc = last.params.minTc == null ? "any comp" : `≥ $${Math.round(last.params.minTc / 1000)}k`
  const fmtYoe = last.params.maxYoe == null ? "any yrs" : `≤ ${last.params.maxYoe} yrs`
  const html = renderUi(last.jobs, {
    title: `Jobs · ${cities.join(" / ")}`,
    subtitle: `${last.date} · ${fmtTc} · ${fmtYoe}${last.params.days != null ? ` · ${last.params.days} d` : ""}`,
    date: last.date,
    floor: last.params.minTc,
    skills: profile?.skills ?? [],
    isLocal: (j) => cityParams.some((p) => matchedLocation(j, { ...p } as SearchParams) !== null),
    storageKey: `jobsweep:${cities.join("|")}`,
  })
  mkdirSync(UI_DIR(), { recursive: true })
  const out = v.out ?? join(UI_DIR(), `jobs-${last.date}.html`)
  await Bun.write(out, html)
  process.stdout.write(`${out}\n# built from the search on ${last.date}: ${last.jobs.length} postings, ${cities.join(" / ")} — run \`jobsweep search\` first to refresh\n`)
  if (v.open) Bun.spawn(process.platform === "win32" ? ["cmd", "/c", "start", "", out] : [process.platform === "darwin" ? "open" : "xdg-open", out], { stdout: "ignore", stderr: "ignore" })
  return 0
}

async function digest(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: { top: { type: "string", default: "15" }, format: { type: "string", short: "f", default: "md" }, profile: { type: "string" }, companies: { type: "string" } },
  })
  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  if (!profile) fail("digest needs a profile: run `jobsweep init`", "NO_PROFILE")
  if (!["md", "json"].includes(v.format)) fail(`--format must be md|json`, "BAD_ARG")
  const top = int("top", v.top)

  const store = new Store()
  const result = await run(paramsFor(profile, {}), profile, makeCtx(await loadCompanies(v.companies ?? COMPANIES_PATH()), store), store)
  store.close()

  const date = new Date().toISOString().slice(0, 10)
  const fresh = result.jobs.filter((j) => result.newIds[j.id])
  const withComp = sortByPay(result.jobs.filter((j) => j.salary))
  const fmtTc = profile.minTc === null ? "any comp" : `≥ $${Math.round(profile.minTc / 1000)}k`
  const fmtYoe = profile.maxYoe === null ? "any experience" : `≤ ${profile.maxYoe} yrs`
  const profileLine = `${profile.cities.join(", ")} · ${profile.queries.length} queries · ${fmtTc} · ${fmtYoe}${profile.days !== null ? ` · last ${profile.days}d` : ""} · ${result.jobs.length} open matches`
  const d = { date, profileLine, fresh, topOpen: withComp.slice(0, top), totalOpen: result.jobs.length, carriedIds: result.carriedIds, dropped: result.dropped, errors: result.errors }

  mkdirSync(DIGEST_DIR(), { recursive: true })
  const md = renderDigest(d)
  await Bun.write(join(DIGEST_DIR(), `${date}.md`), md + "\n")
  await Bun.write(join(DIGEST_DIR(), "latest.json"), JSON.stringify({ ...d, all: result.jobs }, null, 2) + "\n")
  await Bun.write(join(DIGEST_DIR(), "last-search.json"), JSON.stringify({ date, params: { cities: profile.cities, minTc: profile.minTc, maxYoe: profile.maxYoe, days: profile.days }, jobs: result.jobs, carriedIds: Object.keys(result.carriedIds) }))
  process.stdout.write((v.format === "json" ? JSON.stringify({ ...d, all: result.jobs }, null, 2) : md) + "\n")
  return 0
}

async function detail(argv: string[]): Promise<number> {
  const id = argv[0]
  if (!id) fail("detail requires an <id> like greenhouse:stripe:7532733", "NO_ID")
  const [source, ...rest] = id.split(":")
  const provider = PROVIDERS[source as Source]
  if (!provider?.detail) fail(`no detail support for "${source}"`, "BAD_ID")
  const store = new Store()
  const job = (await provider.detail(rest.join(":"), makeCtx(await loadCompanies(COMPANIES_PATH()), store))) ?? store.job(id)
  store.close()
  if (!job) fail(`posting ${id} not found`, "NOT_FOUND")
  process.stdout.write(JSON.stringify(job, null, 2) + "\n")
  return 0
}

const VERIFY_PARAMS: SearchParams = {
  queries: [], titleRe: /./, city: "", remote: "include", minTc: null, maxYoe: null, levels: null, days: null, sources: [], perSource: 0, hydrate: false, linkedinAccepted: false,
}

/** A cache that remembers nothing: board verification must not persist whole boards under a catch-all title gate. */
const NO_CACHE = { get: () => null, set: () => {} }

/** Open-role count for one board; 0 when the board is missing, empty, or unreachable. Never touches the persistent cache. */
async function boardSize(c: Company, ctx: ProviderCtx): Promise<number> {
  try {
    const jobs = await PROVIDERS[c.ats].search(VERIFY_PARAMS, { ...ctx, companies: [c], cache: NO_CACHE, log: () => {} })
    return jobs.length
  } catch (e) {
    ctx.log(`${c.ats}:${c.slug} unreachable — ${e instanceof Error ? e.message : e}`)
    return 0
  }
}

async function companies(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      verify: { type: "boolean", default: false },
      companies: { type: "string" },
      profile: { type: "string" },
      pages: { type: "string", default: "5" },
      days: { type: "string", default: "60" },
      "min-postings": { type: "string", default: "2" },
    },
  })
  const companiesPath = v.companies ?? COMPANIES_PATH()
  const list = await loadCompanies(companiesPath)
  const store = new Store()
  const ctx = makeCtx(list, store)

  if (positionals[0] === "discover") {
    const profile = await loadProfile(v.profile ?? PROFILE_PATH())
    const cities = profile?.cities ?? []
    if (!cities.length) fail("discover needs cities: run `jobsweep init`", "NO_CITY")
    const found = await discoverBoards(cities, { pages: int("pages", v.pages), days: int("days", v.days), log: ctx.log })
    const known: Record<string, true> = {}
    for (const c of list) known[`${c.ats}:${c.slug}`] = true
    const minPostings = int("min-postings", v["min-postings"])
    const candidates = found.filter((c) => !known[`${c.ats}:${c.slug}`] && c.postings >= minPostings)
    ctx.log(`discover: ${found.length} boards seen, ${candidates.length} new — verifying live`)
    const sizes = await pool(candidates, 6, (c) => boardSize(c, ctx))
    const added: Company[] = []
    candidates.forEach((c, i) => {
      const n = sizes[i] ?? 0
      process.stdout.write(`${n ? "add " : "skip"} ${c.ats.padEnd(10)} ${c.slug.padEnd(28)} ${c.name} (${c.postings} here, ${n} open)\n`)
      if (n) added.push({ name: c.name, ats: c.ats, slug: c.slug })
    })
    const merged = [...list, ...added].sort((a, b) => a.name.localeCompare(b.name))
    await Bun.write(companiesPath, JSON.stringify(merged, null, 2) + "\n")
    process.stdout.write(`\n${added.length} boards added → ${merged.length} total in ${companiesPath}\n`)
    store.close()
    return 0
  }

  if (!v.verify) {
    for (const c of list) process.stdout.write(`${c.ats.padEnd(10)} ${c.slug.padEnd(24)} ${c.name}\n`)
    store.close()
    return 0
  }
  let bad = 0
  for (const c of list) {
    const n = await boardSize(c, ctx)
    if (!n) bad++
    process.stdout.write(`${n ? "ok  " : "FAIL"} ${c.ats.padEnd(10)} ${c.slug.padEnd(24)} ${c.name}${n ? ` (${n} open roles)` : " — board not found or empty"}\n`)
  }
  store.close()
  return bad ? 1 : 0
}

function cache(argv: string[]): number {
  const store = new Store()
  if (argv[0] === "clear") {
    const before = store.sizeBytes()
    store.clearCache()
    process.stdout.write(`cache cleared: ${(before / 1048576).toFixed(1)} MB → ${(store.sizeBytes() / 1048576).toFixed(1)} MB\n`)
  } else {
    process.stdout.write(`${(store.sizeBytes() / 1048576).toFixed(1)} MB in ${configDir()}/jobsweep.db (run \`jobsweep cache clear\` to drop cached feeds)\n`)
  }
  store.close()
  return 0
}

loadEnv()
const [cmd, ...rest] = process.argv.slice(2)
const job =
  cmd === "init" ? init()
  : cmd === "search" ? search(rest)
  : cmd === "ui" ? ui(rest)
  : cmd === "digest" ? digest(rest)
  : cmd === "detail" ? detail(rest)
  : cmd === "companies" ? companies(rest)
  : cmd === "cache" ? Promise.resolve(cache(rest))
  : cmd === "--version" || cmd === "-v" ? (process.stdout.write(`${pkg.version}\n`), Promise.resolve(0))
  : cmd === undefined || cmd === "--help" || cmd === "-h" ? (process.stdout.write(HELP), Promise.resolve(cmd ? 0 : 1))
  : fail(`unknown command "${cmd}"`, "BAD_CMD")

// Never process.exit() after a large write: a piped stdout is truncated mid-JSON. Set the code and let the loop drain.
job.then((code) => {
  process.exitCode = code
}).catch((e) => fail(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR"))
