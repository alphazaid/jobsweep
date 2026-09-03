#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import companiesSeed from "../companies.seed.json"
import pkg from "../package.json"
import { Store } from "./db.ts"
import { discoverBoards } from "./discover.ts"
import { matchedLocation } from "./filters.ts"
import { pool } from "./http.ts"
import { init, readEnv, readExistingProfile, report, writeSetup } from "./init.ts"
import { doctor, renderChecks } from "./doctor.ts"
import setupGuide from "../SETUP.md" with { type: "text" }
import { interview } from "./interview.ts"
import { configureModel, MODEL_HELP, type Model } from "./llm.ts"
import { FORMATS, render, renderDigest, renderRanked, sortByPay, type Format, type Report } from "./output.ts"
import { CANDIDATE_PATH, COMPANIES_PATH, DIGEST_DIR, PROFILE_PATH, UI_DIR, configDir } from "./paths.ts"
import { defaultSources, loadEnv, loadProfile, parseMoney, type Profile } from "./profile.ts"
import { PROVIDERS } from "./providers/index.ts"
import type { ProviderCtx } from "./providers/provider.ts"
import { attachReviews, rankJobs, sanitizeResult, saveReview, sortByAi } from "./rank.ts"
import { absoluteLauncherArgv, installSkill, renderSkill, resolveLauncher } from "./skill.ts"
import { describeCadence, install as installSchedule, notify, parseCadence, remove as removeSchedule, status as scheduleStatus } from "./schedule.ts"
import { readLastSearch, startServer, statsOf, summaryText } from "./serve.ts"
import { toCsv, toRows } from "./export.ts"
import { run } from "./run.ts"
import { AGENCY_RE, ALL_SOURCES, DEFAULT_PRESET, DEFAULT_QUERIES, PRESETS, LEVELS, SWE_TITLE_RE, type Company, type Job, type Level, type SearchParams, type Source } from "./types.ts"
import { renderUi } from "./ui.ts"

const HELP = `jobsweep ${pkg.version} — sweep company boards, Adzuna, freehire (and optionally LinkedIn) for software jobs by city, comp, and experience

USAGE
  jobsweep init                       Set up your profile interactively (cities, comp floor, years, skills, sources).
  jobsweep presets                    List role presets (swe, data, devops-sre, security, product, design, marketing,
                                      sales, finance, healthcare, legal, hr-recruiting, any) with what each searches.
  jobsweep init --preset swe --cities "New York, NY;Austin, TX" [--min-tc 200k] [--max-yoe 3] [--days 14]
               [--remote include|only|exclude] [--skills "Go,TypeScript"] [--linkedin] [--skill|--no-skill] [--json] [--dry-run]
                                      The same setup without prompts — for scripts and agents (see SETUP.md). Omitted
                                      flags keep existing values or defaults. Adzuna keys are read from the environment
                                      (ADZUNA_APP_ID / ADZUNA_APP_KEY), never from flags. --json prints the paths written;
                                      --dry-run validates and shows the profile it would write, touching nothing.
  jobsweep doctor [--json]            Check the setup: profile, boards, keys, skill, last search, schedule. Exit 1 if
                                      anything required is missing; each failing line names its fix.
  jobsweep setup-guide                Print SETUP.md: the step-by-step an agent (or you) follows to set this machine up.
  jobsweep search [flags]             Search. Flags override the profile; with a profile, no flags needed.
  jobsweep ui [--open]                Build a one-file triage page from the last search and optionally open it.
  jobsweep digest [--top <n>] [--rank] Run the profile, write digests/<date>.md + latest.json, print the digest.
  jobsweep detail <id>                Full posting JSON (e.g. greenhouse:stripe:7532733, linkedin:4300011451).
  jobsweep companies [--verify]       List company boards; --verify hits each one live.
  jobsweep companies discover         Add every Greenhouse/Lever/Ashby board hiring in your cities (via freehire).
  jobsweep cache [clear]              Show cache size, or drop cached feeds.
  jobsweep serve [-p 4747] [--open]   Local dashboard: stats, history, run-search button with live log, triage page with
                                      server-kept marks, CSV/JSON export. Binds 127.0.0.1 only.
  jobsweep serve -s | -j              The same numbers on the console (summary / JSON), no server.
  jobsweep export [--csv|--json] [--out <file>]
                                      Every posting from the last search with comp, years, fit, AI review, your decision, URL.
  jobsweep schedule --every <30m|6h|1d> | --daily HH:MM
                                      Run the digest on a timer via launchd (macOS), a systemd user timer (Linux), or
                                      Task Scheduler (Windows); a desktop notification only when a run finds new postings.
  jobsweep schedule --status | --remove
  jobsweep skill [--install] [--dir <path>]
                                      Print the agent skill (SKILL.md), or install it so your coding agent — Claude Code,
                                      Codex, Cursor, OMP, anything reading ~/.agents/skills — runs jobsweep when you ask
                                      it to find, rank, or export jobs. \`init\` offers this too.
  jobsweep review --pending [--limit 12] [--new]
                                      Next unreviewed postings (comp ceiling first) as JSON, trimmed for judging.
  jobsweep review [--model <name>]    Attach reviews written by the calling agent (no API key needed): JSON on stdin
                                      {"results":[{"id","fit":1-5,"reason","dealbreakers":[],"emphasize":[]}]} or one via
                                      --id --fit --reason. Same bounds as \`rank\`; shown in ui/serve/export/digest.
  jobsweep review --clear <id>... | --clear-all
                                      Retract reviews (agent or model) from the last search and the store.

WITH A MODEL (optional — bring your own key; search/digest never call a model unless asked)
  jobsweep interview [--resume <file>] [--notes <file>]...
                                      Build candidate.md from your resume/notes (and LifeOS files if present, with your
                                      confirmation), then a short Q&A for what documents can't say. Suggested profile
                                      changes are confirmed one by one.
  jobsweep rank                       Score the last search's survivors 1–5 against candidate.md with reasons; cached per
                                      posting so re-runs only pay for new postings. Then \`jobsweep ui\` shows them.
  Configure: JOBSWEEP_MODEL or "model" in profile.json = openai:<model> | anthropic:<model>, plus OPENAI_API_KEY
  (OPENAI_BASE_URL for OpenRouter/Ollama/LM Studio) or ANTHROPIC_API_KEY in ${configDir()}/.env.

Config lives in ${configDir()} (override with JOBSWEEP_HOME): profile.json, candidate.md, companies.json, metros.json, .env, jobsweep.db, digests/, ui/

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
    sources: over.sources ?? profile?.sources ?? defaultSources(),
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
  const jobs = attachReviews(result.jobs, store)
  store.close()

  let shown = v.new ? jobs.filter((j) => result.newIds[j.id]) : jobs
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
  await Bun.write(join(DIGEST_DIR(), "last-search.json"), JSON.stringify({ date: new Date().toISOString().slice(0, 10), params: report.params, jobs, carriedIds: Object.keys(result.carriedIds), newIds: Object.keys(result.newIds) }))
  return 0
}

interface LastSearch {
  date: string
  params: { cities: string[]; minTc: number | null; maxYoe: number | null; days: number | null }
  jobs: Job[]
  carriedIds?: string[]
  newIds?: string[]
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

/** The configured model, or a clear failure naming how to configure one. */
function requireModel(profile: Profile | null): Model {
  try {
    const m = configureModel(profile?.model)
    if (!m) fail(MODEL_HELP, "NO_MODEL")
    return m
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "MODEL_CONFIG")
  }
}

function requireCandidate(): string {
  const p = CANDIDATE_PATH()
  if (!existsSync(p)) fail(`no candidate profile yet — run \`jobsweep interview\` (writes ${p})`, "NO_CANDIDATE")
  return readFileSync(p, "utf8")
}

async function interviewCmd(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: { resume: { type: "string" }, notes: { type: "string", multiple: true }, lifeos: { type: "boolean" }, "no-lifeos": { type: "boolean", default: false }, "max-questions": { type: "string", default: "8" }, profile: { type: "string" } },
  })
  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  const model = requireModel(profile)
  return interview({ model, resume: v.resume, notes: v.notes, lifeos: v["no-lifeos"] ? false : v.lifeos, maxQuestions: int("max-questions", v["max-questions"]) })
}

async function rank(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { format: { type: "string", short: "f", default: "table" }, limit: { type: "string" }, profile: { type: "string" } } })
  const lastPath = join(DIGEST_DIR(), "last-search.json")
  if (!existsSync(lastPath)) fail("no search yet — run `jobsweep search` first", "NO_SEARCH")
  const last = (await Bun.file(lastPath).json()) as LastSearch
  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  const model = requireModel(profile)
  const candidate = requireCandidate()
  const fmt = v.format as Format
  if (!FORMATS.includes(fmt)) fail(`--format must be one of ${FORMATS.join("|")}`, "BAD_ARG")

  const store = new Store()
  const ranked = await rankJobs(last.jobs, { model, candidate, cache: store, log: (m) => process.stderr.write(`# ${m}\n`) })
  store.close()
  await Bun.write(lastPath, JSON.stringify({ ...last, jobs: ranked }))

  const limit = v.limit !== undefined ? int("limit", v.limit) : null
  const sorted = sortByAi(ranked)
  const shown = limit === null ? sorted : sorted.slice(0, limit)
  if (fmt === "json") process.stdout.write(JSON.stringify(shown, null, 2) + "\n")
  else process.stdout.write(renderRanked(shown, fmt === "md") + "\n")
  process.stderr.write(`# reviews saved into ${lastPath}; \`jobsweep ui --open\` to triage with them\n`)
  return 0
}

async function digest(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: { top: { type: "string", default: "15" }, format: { type: "string", short: "f", default: "md" }, rank: { type: "boolean", default: false }, notify: { type: "boolean", default: false }, profile: { type: "string" }, companies: { type: "string" } },
  })
  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  if (!profile) fail("digest needs a profile: run `jobsweep init`", "NO_PROFILE")
  if (!["md", "json"].includes(v.format)) fail(`--format must be md|json`, "BAD_ARG")
  const top = int("top", v.top)
  // Resolve the model up front so a misconfiguration fails before the sweep, not after it.
  const model = v.rank ? requireModel(profile) : null
  const candidate = v.rank ? requireCandidate() : null

  const store = new Store()
  const result = await run(paramsFor(profile, {}), profile, makeCtx(await loadCompanies(v.companies ?? COMPANIES_PATH()), store), store)
  // With --rank, only what's new gets reviewed: the digest's job is "what came in", and this bounds the model spend.
  let jobs = attachReviews(result.jobs, store)
  if (model && candidate) {
    const freshIds = new Set(Object.keys(result.newIds))
    const reviewed = await rankJobs(jobs.filter((j) => freshIds.has(j.id)), { model, candidate, cache: store, log: (m) => process.stderr.write(`# ${m}\n`) })
    const byId = new Map(reviewed.map((j) => [j.id, j]))
    jobs = jobs.map((j) => byId.get(j.id) ?? j)
  }
  store.close()

  const date = new Date().toISOString().slice(0, 10)
  const fresh = jobs.filter((j) => result.newIds[j.id])
  const withComp = sortByPay(jobs.filter((j) => j.salary))
  const fmtTc = profile.minTc === null ? "any comp" : `≥ $${Math.round(profile.minTc / 1000)}k`
  const fmtYoe = profile.maxYoe === null ? "any experience" : `≤ ${profile.maxYoe} yrs`
  const profileLine = `${profile.cities.join(", ")} · ${profile.queries.length} queries · ${fmtTc} · ${fmtYoe}${profile.days !== null ? ` · last ${profile.days}d` : ""} · ${jobs.length} open matches`
  const d = { date, profileLine, fresh, topOpen: withComp.slice(0, top), totalOpen: jobs.length, carriedIds: result.carriedIds, dropped: result.dropped, errors: result.errors }

  mkdirSync(DIGEST_DIR(), { recursive: true })
  const md = renderDigest(d)
  await Bun.write(join(DIGEST_DIR(), `${date}.md`), md + "\n")
  await Bun.write(join(DIGEST_DIR(), "latest.json"), JSON.stringify({ ...d, all: jobs }, null, 2) + "\n")
  await Bun.write(join(DIGEST_DIR(), "last-search.json"), JSON.stringify({ date, params: { cities: profile.cities, minTc: profile.minTc, maxYoe: profile.maxYoe, days: profile.days }, jobs, carriedIds: Object.keys(result.carriedIds), newIds: Object.keys(result.newIds) }))
  process.stdout.write((v.format === "json" ? JSON.stringify({ ...d, all: jobs }, null, 2) : md) + "\n")
  // Scheduled runs happen many times a day; only a run that found something is worth interrupting the user for.
  if (v.notify && fresh.length) notify("jobsweep", `${fresh.length} new posting${fresh.length === 1 ? "" : "s"} · ${jobs.length} open`)
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
    const found = await discoverBoards(cities, { pages: int("pages", v.pages), days: int("days", v.days), categories: profile!.preset.discoverCategories, queries: profile!.queries, log: ctx.log })
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

async function serve(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { port: { type: "string", short: "p", default: "4747" }, open: { type: "boolean", default: false }, json: { type: "boolean", short: "j", default: false }, summary: { type: "boolean", short: "s", default: false }, profile: { type: "string" } } })
  if (v.json || v.summary) {
    // Console modes, like `omp stats -j` / `-s`: same numbers as the page, no server.
    const store = new Store()
    const stats = statsOf(await readLastSearch(), store)
    store.close()
    process.stdout.write(v.json ? JSON.stringify(stats, null, 2) + "\n" : summaryText(stats))
    return 0
  }
  const profile = await loadProfile(v.profile ?? PROFILE_PATH())
  const port = int("port", v.port)
  // Relaunch this same entrypoint for "Run search now" — works from source (`bun run src/cli.ts`) and from the compiled binary alike.
  const self = process.argv[1] && process.argv[1].endsWith(".ts") ? ["bun", "run", process.argv[1], "search"] : [process.execPath, "search"]
  const server = startServer({ port, profile, searchCommand: self, log: (m) => process.stderr.write(`# ${m}\n`) })
  const url = `http://127.0.0.1:${server.port}`
  process.stdout.write(`jobsweep dashboard at ${url}  (Ctrl-C to stop)\n`)
  if (v.open) Bun.spawn(process.platform === "win32" ? ["cmd", "/c", "start", "", url] : [process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" })
  await new Promise(() => {}) // run until killed
  return 0
}

async function exportCmd(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { csv: { type: "boolean", default: false }, json: { type: "boolean", default: false }, out: { type: "string" } } })
  const last = await readLastSearch()
  if (!last) fail("no search yet — run `jobsweep search` first", "NO_SEARCH")
  const store = new Store()
  const rows = toRows(last.jobs, store.decisions())
  store.close()
  const asCsv = v.csv || (!v.json && (v.out?.endsWith(".csv") ?? true))
  const body = asCsv ? toCsv(rows) : JSON.stringify(rows, null, 2) + "\n"
  if (v.out) {
    await Bun.write(v.out, body)
    process.stdout.write(`${v.out}: ${rows.length} postings\n`)
  } else process.stdout.write(body)
  return 0
}

/** What an agent needs to judge a posting, and nothing more: keeps a batch of 12 well inside any context window. */
const PENDING_DESC_CHARS = 2_500

async function review(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { model: { type: "string", default: "agent" }, id: { type: "string" }, fit: { type: "string" }, reason: { type: "string" }, dealbreaker: { type: "string", multiple: true }, emphasize: { type: "string", multiple: true }, file: { type: "string" }, pending: { type: "boolean", default: false }, limit: { type: "string", default: "12" }, new: { type: "boolean", default: false }, clear: { type: "string", multiple: true }, "clear-all": { type: "boolean", default: false } } })
  const lastPath = join(DIGEST_DIR(), "last-search.json")
  if (!existsSync(lastPath)) fail("no search yet — run `jobsweep search` first", "NO_SEARCH")
  const last = (await Bun.file(lastPath).json()) as LastSearch

  if (v.pending) {
    // Unreviewed postings, comp ceiling first (new-only with --new), trimmed to what a judgment needs.
    const newIds = new Set(last.newIds ?? [])
    const pending = last.jobs
      .filter((j) => !j.ai && (!v.new || newIds.has(j.id)))
      .sort((a, b) => (b.salary?.max ?? b.salary?.min ?? 0) - (a.salary?.max ?? a.salary?.min ?? 0))
    const batch = pending.slice(0, int("limit", v.limit)).map((j) => ({
      id: j.id, title: j.title, company: j.company, location: j.location, workMode: j.workMode, salary: j.salary, yoeMin: j.yoeMin, level: j.level, skillsMatched: j.fit?.matched ?? [], url: j.url,
      description: (j.description ?? "").slice(0, PENDING_DESC_CHARS),
    }))
    process.stdout.write(JSON.stringify({ pending: pending.length, reviewed: last.jobs.length - pending.length - last.jobs.filter((j) => v.new && !newIds.has(j.id) && !j.ai).length, batch }, null, 2) + "\n")
    return 0
  }

  if (v.clear?.length || v["clear-all"]) {
    const ids = v["clear-all"] ? last.jobs.filter((j) => j.ai).map((j) => j.id) : v.clear!
    const byId = new Map(last.jobs.map((j) => [j.id, j]))
    const unknownIds = ids.filter((id) => !byId.has(id))
    if (unknownIds.length) fail(`not in the last search: ${unknownIds.join(", ")}`, "UNKNOWN_ID")
    const store = new Store()
    let n = 0
    for (const id of ids) {
      byId.get(id)!.ai = null
      store.clearReviews(id)
      n++
    }
    store.close()
    await Bun.write(lastPath, JSON.stringify(last))
    process.stdout.write(`cleared reviews on ${n} posting(s)\n`)
    return 0
  }

  let items: unknown[]
  if (v.id) {
    if (!v.fit) fail("--fit 1-5 is required with --id", "BAD_ARG")
    items = [{ id: v.id, fit: v.fit, reason: v.reason ?? "", dealbreakers: v.dealbreaker ?? [], emphasize: v.emphasize ?? [] }]
  } else {
    const text = v.file ? await Bun.file(v.file).text() : await Bun.stdin.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      fail("expected JSON on stdin (or --file): {\"results\":[{\"id\",\"fit\",\"reason\",...}]} or a bare array", "BAD_JSON")
    }
    items = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "results" in parsed && Array.isArray(parsed.results) ? parsed.results : []
    if (!items.length) fail("no results in input", "BAD_JSON")
  }
  const byId = new Map(last.jobs.map((j) => [j.id, j]))
  const store = new Store()
  let applied = 0
  const unknown: string[] = []
  const malformed: number[] = []
  items.forEach((raw, i) => {
    const r = sanitizeResult(raw, v.model)
    if (!r) return void malformed.push(i)
    const j = byId.get(r.id)
    if (!j) return void unknown.push(r.id)
    j.ai = r.review
    saveReview(j, r.review, store)
    applied++
  })
  store.close()
  await Bun.write(lastPath, JSON.stringify(last))
  const notes = [unknown.length ? `${unknown.length} id(s) not in the last search: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? ", …" : ""}` : "", malformed.length ? `${malformed.length} item(s) malformed (need id and a numeric fit)` : ""].filter(Boolean)
  process.stdout.write(`${applied} review(s) saved as ${v.model}${notes.length ? ` · ${notes.join(" · ")}` : ""}\n`)
  return applied ? 0 : 1
}

function skill(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { install: { type: "boolean", default: false }, dir: { type: "string", multiple: true } } })
  const launcher = resolveLauncher()
  if (!v.install) {
    process.stdout.write(renderSkill(launcher))
    return 0
  }
  for (const p of installSkill(v.dir, launcher)) process.stdout.write(`installed ${p}\n`)
  process.stdout.write(`the skill invokes the CLI as: ${launcher}\n`)
  return 0
}

/** `init` with flags: no prompts, so an agent or a script can set a machine up in one call. */
function initFlags(argv: string[]): number {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      preset: { type: "string" }, cities: { type: "string" }, "min-tc": { type: "string" }, "max-yoe": { type: "string" }, days: { type: "string" }, remote: { type: "string" }, skills: { type: "string" },
      linkedin: { type: "boolean" }, "no-linkedin": { type: "boolean", default: false },
      skill: { type: "boolean" }, "no-skill": { type: "boolean", default: false }, json: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false },
    },
  })
  const existing = readExistingProfile()
  const env = readEnv()
  const split = (s: string, sep: string) => s.split(sep).map((x) => x.trim()).filter(Boolean)
  const cities = v.cities !== undefined ? split(v.cities, ";") : ((existing.cities as string[] | undefined) ?? [])
  if (!cities.length) fail("--cities is required the first time (e.g. --cities \"New York, NY\"; separate several with ;)", "NO_CITY")
  try {
    const preset = v.preset ?? String(existing.preset ?? DEFAULT_PRESET.name)
    const r = writeSetup({
      preset,
      cities,
      minTc: v["min-tc"] ?? (existing.minTc == null ? "" : String(existing.minTc)),
      maxYoe: v["max-yoe"] ?? (existing.maxYoe == null ? "" : String(existing.maxYoe)),
      days: v.days !== undefined ? int("days", v.days) : Number(existing.days ?? 14),
      remote: v.remote ?? String(existing.remote ?? "include"),
      skills: v.skills !== undefined ? split(v.skills, ",") : existing.preset === preset ? ((existing.skills as string[] | undefined) ?? PRESETS[preset]?.skills ?? []) : (PRESETS[preset]?.skills ?? []),
      linkedin: v["no-linkedin"] ? false : (v.linkedin ?? existing.linkedinAccepted === true),
      // Secrets never ride on argv (shell history, `ps`): unattended setup takes them from the environment,
      // falling back to what an earlier setup already saved.
      adzunaId: process.env.ADZUNA_APP_ID ?? env.ADZUNA_APP_ID ?? "",
      adzunaKey: process.env.ADZUNA_APP_KEY ?? env.ADZUNA_APP_KEY ?? "",
      installSkill: v["no-skill"] ? false : (v.skill ?? true),
    }, v["dry-run"])
    if (v.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n")
    else report(r)
    return 0
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "BAD_ARG")
  }
}

async function doctorCmd(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { json: { type: "boolean", default: false } } })
  const checks = await doctor()
  process.stdout.write(v.json ? JSON.stringify(checks, null, 2) + "\n" : renderChecks(checks))
  return checks.every((c) => c.ok || !c.required) ? 0 : 1
}

function presets(): number {
  const w = Math.max(...Object.keys(PRESETS).map((k) => k.length))
  for (const [k, p] of Object.entries(PRESETS)) {
    process.stdout.write(`${k.padEnd(w)}  ${p.description}\n${" ".repeat(w + 2)}searches: ${p.queries.join(" · ") || "(your queries)"}\n`)
  }
  process.stdout.write(`\nPick one with \`jobsweep init --preset <name>\` (or answer the first init question). profile.json's titlePattern, queries, skills, exclude override the preset.\n`)
  return 0
}

function schedule(argv: string[]): number {
  const { values: v } = parseArgs({ args: argv, strict: true, options: { every: { type: "string" }, daily: { type: "string" }, status: { type: "boolean", default: false }, remove: { type: "boolean", default: false } } })
  if (v.status) {
    const st = scheduleStatus()
    process.stdout.write(`${st.active ? "scheduled" : "not scheduled"} · ${st.detail}\n`)
    return st.active ? 0 : 1
  }
  if (v.remove) {
    process.stdout.write(`removed ${removeSchedule()}\n`)
    return 0
  }
  if (v.every === undefined && v.daily === undefined) fail("say how often: --every 6h, --every 1d, or --daily 06:40 (or --status / --remove)", "BAD_ARG")
  let cadence
  try {
    cadence = parseCadence(v.every, v.daily)
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "BAD_ARG")
  }
  const argv2 = [...absoluteLauncherArgv(), "digest", "--notify"]
  try {
    const r = installSchedule(argv2, cadence)
    process.stdout.write(`scheduled ${describeCadence(cadence)}: ${argv2.join(" ")}\n  ${r.installed}\n  log: ${r.log}\n`)
    return 0
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "SCHEDULE_FAILED")
  }
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
  cmd === "init" ? (rest.length ? Promise.resolve(initFlags(rest)) : init())
  : cmd === "doctor" ? doctorCmd(rest)
  : cmd === "presets" ? Promise.resolve(presets())
  : cmd === "setup-guide" ? (process.stdout.write(setupGuide), Promise.resolve(0))
  : cmd === "search" ? search(rest)
  : cmd === "ui" ? ui(rest)
  : cmd === "interview" ? interviewCmd(rest)
  : cmd === "rank" ? rank(rest)
  : cmd === "digest" ? digest(rest)
  : cmd === "detail" ? detail(rest)
  : cmd === "companies" ? companies(rest)
  : cmd === "cache" ? Promise.resolve(cache(rest))
  : cmd === "serve" ? serve(rest)
  : cmd === "export" ? exportCmd(rest)
  : cmd === "review" ? review(rest)
  : cmd === "skill" ? Promise.resolve(skill(rest))
  : cmd === "schedule" ? Promise.resolve(schedule(rest))
  : cmd === "--version" || cmd === "-v" ? (process.stdout.write(`${pkg.version}\n`), Promise.resolve(0))
  : cmd === undefined || cmd === "--help" || cmd === "-h" ? (process.stdout.write(HELP), Promise.resolve(cmd ? 0 : 1))
  : fail(`unknown command "${cmd}"`, "BAD_CMD")

// Never process.exit() after a large write: a piped stdout is truncated mid-JSON. Set the code and let the loop drain.
job.then((code) => {
  process.exitCode = code
}).catch((e) => fail(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR"))
