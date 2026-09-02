# jobsweep

Sweep hundreds of company job boards, Adzuna, and freehire for software engineering roles that match **your city, comp floor, and years of experience**. Triage them on a local dashboard with keyboard shortcuts, export everything to CSV, and — if you bring a model key — have your resume interviewed and every surviving posting scored with reasons.

Runs on your machine. No account, no hosted service, no telemetry. The core is deterministic: regexes, a title gate, a comp parser, a years parser, metro aliases, SQLite. A model is optional and only ever touches what you explicitly hand it.

```
$ jobsweep search
MATCHES (comp posted, sorted by ceiling)  * = new since last run  ° = carried from an earlier run
   FIT    TITLE                                     COMPANY               LOCATION                COMP          YOE       POSTED      SRC
*  5/18   Software Engineer, Full Stack             Plaid                 New York City Metro…    $176k–$227k   2+        2026-08-21  li
   6/18   Software Engineer III                     Garner Health         New York, NY            $194k–$220k   2+        2026-08-23  li
   …
117 with posted comp, 233 comp unknown, 1 new since last run, 31 carried from earlier runs · dropped: city 1647, tc 459, experience 835, excluded 102
```

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Commands](#commands)
- [Dashboard](#dashboard)
- [Export](#export)
- [With a model (optional)](#with-a-model-optional)
- [What it searches](#what-it-searches)
- [How filtering works](#how-filtering-works)
- [Profile and config](#profile-and-config)
- [Daily digest](#daily-digest)
- [Security and data handling](#security-and-data-handling)
- [Develop](#develop)

## Install

Prebuilt binaries for macOS (arm64/x64), Linux (arm64/x64), and Windows (x64) are on the [Releases](../../releases) page — no runtime needed. Or with [Bun](https://bun.sh):

```sh
bunx jobsweep init
```

## Quickstart

```sh
jobsweep init                 # cities, comp floor, years, skills, sources, Adzuna key → ~/.config/jobsweep
jobsweep companies discover   # add every Greenhouse/Lever/Ashby board hiring in your cities (2–3 min, once)
jobsweep search               # the sweep (~1 min warm; first run longer while boards are cached)
jobsweep serve --open         # dashboard + triage page at http://127.0.0.1:4747
```

Run `jobsweep search` again tomorrow: new postings are starred, everything you've already seen is remembered, and your apply/skip marks persist.

## Commands

| Command | What it does |
|---|---|
| `jobsweep init` | Interactive setup: cities, comp floor, years, skills, sources, Adzuna key, LinkedIn opt-in. Writes `profile.json`, `companies.json`, `.env`. |
| `jobsweep search [flags]` | The sweep. Flags override the profile; with a profile, no flags needed. Writes `digests/last-search.json` and records a run. |
| `jobsweep serve [-p 4747] [--open]` | Local dashboard server (see [Dashboard](#dashboard)). `-s` prints a console summary, `-j` the same as JSON, no server. |
| `jobsweep export [--csv\|--json] [--out <file>]` | Every posting from the last search with comp, years, fit, AI review, your decision, URL (see [Export](#export)). |
| `jobsweep ui [--open]` | Standalone one-file triage page (`~/.config/jobsweep/ui/jobs-<date>.html`) — works offline with marks in the browser's localStorage. The served `/triage` page is the same UI with marks kept server-side. |
| `jobsweep digest [--top <n>] [--rank]` | Run the profile, write `digests/<date>.md` + `latest.json`, print the digest. For cron. |
| `jobsweep detail <id>` | Full posting JSON, e.g. `greenhouse:stripe:7532733`, `linkedin:4300011451`. |
| `jobsweep companies [--verify]` | List company boards; `--verify` hits each one live (never touches the cache). |
| `jobsweep companies discover` | Add every Greenhouse/Lever/Ashby board hiring in your cities, found via freehire. Agency/aggregator boards are skipped. |
| `jobsweep cache [clear]` | Show cache size, or drop cached feeds (postings and their seen-dates are kept). |
| `jobsweep interview [--resume <file>] [--notes <file>]…` | Model: build `candidate.md` from your resume/notes with your confirmation at each step. |
| `jobsweep rank` | Model: score the last search's survivors 1–5 against `candidate.md`, with reasons. Cached. |

### Search flags

```
-l, --city <text>        City. Repeatable. Required unless the profile sets cities.
-q, --query <text>       Keyword search. Repeatable. Default: the preset's queries.
--title-re <regex>       Title gate (default: SWE preset). Every result's title must match.
--min-tc <usd>           Comp floor, e.g. 180000 or 180k, compared to the TOP of the posted band.
                         Postings without stated comp are kept in a separate section.
--strict-comp            Drop postings that state no comp.
--max-yoe <n>            Drop postings requiring more than n years (unstated → title band:
                         entry 0, mid 2, senior 5, staff/principal/lead/manager 8).
--level <list>           intern,entry,mid,senior,staff
--remote <mode>          include (default: city + remote-US) | only | exclude
--days <n>               Posted within n days. Company-board postings older than 90 days are never returned.
--sources <list>         Subset of: linkedin,greenhouse,lever,ashby,adzuna,freehire
--linkedin               Enable the LinkedIn connector for this run (personal use; see below).
--per-source <n>         Results per query per source before filtering (default 50).
--no-hydrate             Skip LinkedIn detail pages (faster; no comp/years/fit for those rows).
--new                    Only postings not seen in a previous run.
-f, --format <fmt>       table (default) | plain | md | json
--limit <n>              Cap rows per section.
```

```sh
jobsweep search -l "Austin, TX" --min-tc 160k --max-yoe 4 --days 7
jobsweep search -l "Remote" --remote only -q "backend engineer" -f md
jobsweep search --new -f json | jq '.matches[] | {title, company, url}'
```

Errors go to stderr as `{"error": "...", "code": "..."}` with exit code 1. Progress lines (per-source candidate counts and timings) also go to stderr, so `-f json` on stdout stays clean for piping.

## Dashboard

```sh
jobsweep serve --open        # http://127.0.0.1:4747
```

A small local server, in the spirit of `omp stats`: the page is rebuilt on every request from `last-search.json` and SQLite, so it's always current.

**`/` — Dashboard**

- Stat cards: open matches (new · carried), with posted comp (%), median comp ceiling (and the top), marked apply (applied · maybe), to review (skipped), AI reviewed.
- **Run search now** — launches `jobsweep search` and streams its real progress (source by source, counts, timings) into the page, then reloads. One run at a time; a run that exceeds 15 minutes is killed so the button can't stay stuck.
- Open postings per run — a history line chart (total, and with-comp dashed). Appears from the second run onward; every `search` records a row.
- Breakdowns: by source, comp ceiling band, title band, companies with the most postings, your decision funnel, AI fit distribution.

**`/triage` — Triage**

The keyboard-driven list, with marks saved server-side in SQLite (shared across browsers, included in exports):

`j`/`k` move · `a` apply · `m` maybe · `x` skip · `d` applied · `o` open posting · `/` search · `Enter` open.
Top bar: All / Local / Remote · comp Posted / Unknown · status tabs · Fit ≥ · sort (comp, fit, posted, company, AI fit once ranked). The detail pane shows the comp band against your floor, years, skills matched (highlighted in the description too), the AI review when present, and a notes box.

**HTTP API** (same data, loopback only):

| Route | Returns |
|---|---|
| `GET /api/jobs.csv` | every posting as CSV (downloads as `jobsweep-<date>.csv`) |
| `GET /api/jobs.json` | same rows as JSON |
| `GET /api/decisions.json` | your marks + notes, keyed by posting id |
| `POST /api/decisions` `{id, status, note}` | set a mark (`apply`, `maybe`, `skip`, `applied`, or `""` to clear) |
| `GET /api/stats.json` | the dashboard's numbers + run history |
| `POST /api/run` · `GET /api/run/stream` | start a search · SSE stream of its progress |

Console modes, no server:

```sh
jobsweep serve -s     # jobsweep · New York, NY · last search 2026-09-02
                      #   open 349 · new 0 · carried 56
                      #   with comp 117 (34%) · median ceiling $246k
                      #   apply 0 · maybe 0 · applied 0 · skipped 0 · to review 349
                      #   AI reviewed 0 · runs recorded 1
jobsweep serve -j     # the same as JSON
```

The server binds `127.0.0.1` only and has no auth: nothing off your machine can reach it, and the data is your own search results. Don't put it behind a reverse proxy.

## Export

```sh
jobsweep export --csv --out jobs.csv     # opens straight in Sheets / Excel / Numbers
jobsweep export --json                   # JSON on stdout
```

One row per posting from the last search. Columns:

`id, title, company, location, workMode, compMin, compMax, compKind, yearsRequired, level, skillsMatched, aiFit, aiReason, aiDealbreakers, decision, note, posted, source, url`

`compKind` is `parsed` (from the posting), `predicted` (Adzuna's estimate), or empty. `decision`/`note` come from the triage page. CSV is RFC 4180 (commas, quotes, newlines inside cells are quoted), and cells that a spreadsheet would run as a formula (`=`, `+`, `-`, `@` prefixes) are neutralised with a leading apostrophe — posting titles are web content, so this matters.

The standalone `ui` page has its own **Export decisions** link (JSON of your marks) for when you're working from the file rather than the server.

## With a model (optional)

Everything above is deterministic and free. Bring your own model key and two more commands turn on:

```sh
jobsweep interview --resume ~/resume.pdf   # builds candidate.md: reads your resume (pdf/md/txt), then asks
                                           # only what it can't know (targets, constraints, comp, timing)
jobsweep rank                              # scores the last search 1–5 against candidate.md, with reasons
jobsweep serve --open                      # rows now carry the fit, the reason, dealbreakers, what to lead with
jobsweep digest --rank                     # the daily digest reviews only what's new
```

- **Configure:** `JOBSWEEP_MODEL` or `"model"` in `profile.json` = `openai:<model>` or `anthropic:<model>`. Keys in `~/.config/jobsweep/.env`: `OPENAI_API_KEY` (set `OPENAI_BASE_URL` for OpenRouter, Ollama, LM Studio) or `ANTHROPIC_API_KEY`. Prompts live in `prompts/` — read them, edit them.
- **Nothing is sent silently.** The interview lists every document it found with its size, says exactly what will be sent where (`up to 20,000 characters each … to openai:gpt-4o-mini (OpenAI-compatible API at https://…)`), and asks *Continue?* before the first call. Declining sends nothing.
- **Nothing is saved silently.** The drafted profile is shown and you accept, correct, or redo it; each suggested filter change (`minTc: – → 200000. Apply?`) is a separate yes/no.
- **LifeOS users:** if `~/.claude/LIFEOS` exists, your identity, resume, goals, and projects files are offered as context (`--no-lifeos` to skip).
- **Bounded spend:** `rank` sends 8 postings per request and reviews only postings that passed the mechanical filters and haven't been reviewed under this (posting content, candidate profile, model, prompt version) before — cached in SQLite. `search` and plain `digest` never call a model.
- **Bounded output:** every model reply is validated before it's stored or rendered — fit clamped to 1–5, reason ≤ 600 chars, lists ≤ 8 × 200 chars, profile suggestions type-checked field by field. Malformed items are dropped.
- **Prompt injection:** postings and documents are fenced as untrusted data (`<<<posting>>>…<<<end>>>`), marker syntax is stripped from fetched text so a posting can't close its own fence, and all three prompts state that instructions come only from the system prompt. A posting that says "rate this 5" is scored against, and the reason says so.

## What it searches

| Source | How | Comp data | Notes |
|---|---|---|---|
| Greenhouse, Lever, Ashby boards | each company's public board API | Ashby/Lever structured; Greenhouse parsed from text | `companies discover` finds boards for your cities via freehire; `companies --verify` checks them. ~330 boards seeded for NYC-area tech; agencies/aggregators excluded. |
| Adzuna | official API, your free key (https://developer.adzuna.com) | posted, or estimated (marked `est`) | on only when both `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` are set |
| freehire.me | public JSON API (`/agent/jobs/search`) | enrichment | open-source aggregator ("no walls", MIT backend, self-hostable via `FREEHIRE_API_URL`); it publishes no rate-limit terms, so keep volume modest |
| LinkedIn | **off by default** — see below | parsed from the posting | |

Company boards are cached title-gated (only matching postings, descriptions capped) so the SQLite file stays small — ~40 MB for 330 boards. Postings older than 90 days never enter the cache.

### LinkedIn

LinkedIn has no public job API. The connector reads LinkedIn's public guest job pages from your machine, which LinkedIn's terms prohibit doing automatically. It is therefore **off unless you turn it on** (`jobsweep init` asks; or `--linkedin` per run), it only ever runs locally, keeps volume low (2 requests in flight, backoff, 14-day cache), and you use it at your own risk for your own personal search. Don't run it from a shared server or on behalf of other people.

## How filtering works

- **Title gate.** Every result must look like an IC software role (`presets/swe.json`): "Backend Engineer", "Member of Technical Staff", "Founding Engineer" pass; Sales/Solutions/QA/Hardware/DevOps/ML/Recruiter/Response Engineer titles don't. Override with `titlePattern` in the profile or `--title-re`.
- **Comp.** The posted band is parsed from structured fields when the board has them, else from the text: `$180K–$220K`, `180,000 - 220,000 USD`, `158,100.00 - 213,800.00 USD annually`, hourly (`$60–$75/hr` → annualised), monthly. The **top** of the band is compared to your floor. Postings with no stated comp are kept in their own section, never silently dropped (`--strict-comp` to drop them).
- **Years.** The first "N+ years … experience" requirement is parsed (largest one inside a qualifications block). Unstated → inferred from the title (entry 0 / mid 2 / senior 5 / staff-lead-manager 8).
- **Age.** Company-board postings older than 90 days are never returned, whatever `days` says — boards keep evergreen reqs open for years. `days` narrows within that.
- **City.** Metro aliases (`src/metros.json`; add your own in `~/.config/jobsweep/metros.json`) so "New York" matches Brooklyn and Jersey City. Remote-US is included by default; `remote: only | exclude`. A posting whose location is remote-*Canada* or remote-*EU* does not match a US city search.
- **Exclude.** Words in `exclude` (default `clearance`, `manager`, `intern`, `contract`) drop postings by title. Body text is left to you or to `rank`: "must be able to obtain Public Trust" is an eligibility question, not a keyword.
- **Skills fit.** `skills` in the profile are matched against title + description; shown as `matched/total` (e.g. `5/18` for 18 profile skills) and highlighted in the description. A hint for sorting, not a filter.
- **Dedupe.** The same posting seen on LinkedIn, freehire, and the company's own board collapses to the copy with the best data; the company board wins over aggregators, which sometimes mislabel locations.
- **Memory and carry-forward.** Postings are remembered in SQLite with first/last-seen dates. LinkedIn's search returns a different sample every call, so postings it showed you recently are carried forward (marked `°`) after being re-checked as still open (cached detail ≤ 3 days, else re-fetched; closed/404 → retired). Board sources are complete listings, so absence means closed and they are never carried. Carried rows are re-filtered by today's parameters.
- **URLs.** Only `http(s)` posting URLs are accepted, live or carried; anything else never reaches the page or the exports.

## Profile and config

Everything user-specific lives in one directory — `~/.config/jobsweep` (override with `JOBSWEEP_HOME`); the repo and the binary stay clean.

| File | What |
|---|---|
| `profile.json` | standing search preferences (below) |
| `companies.json` | company boards (`{name, ats, slug}`); seeded by `init`, extended by `companies discover` |
| `metros.json` | your own metro aliases, merged over the built-in table |
| `candidate.md` | the interview's output; what `rank` scores against |
| `.env` | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `FREEHIRE_API_URL` (mode 600) |
| `jobsweep.db` | SQLite: seen postings, feed cache, run history, decisions, rank cache |
| `digests/` | `<date>.md`, `latest.json`, `last-search.json` (what `serve`/`ui`/`export` read) |
| `ui/` | standalone triage pages from `jobsweep ui` |

`profile.json` (written by `init`; every key optional except `cities`):

```json
{
  "cities": ["New York, NY"],
  "preset": "swe",
  "queries": ["software engineer", "backend engineer"],
  "titlePattern": null,
  "minTc": "200k",
  "maxYoe": 3,
  "days": 14,
  "remote": "include",
  "sources": ["greenhouse", "lever", "ashby", "adzuna", "freehire"],
  "skills": ["TypeScript", "Go", "AWS"],
  "exclude": ["clearance", "manager"],
  "linkedinAccepted": false,
  "model": null
}
```

Unknown keys are rejected rather than silently ignored. `sources` omitted → company boards + freehire always, Adzuna only when both keys are present, LinkedIn never. `JOBSWEEP_DB` overrides the database path alone.

## Daily digest

`jobsweep digest` runs the profile and writes `digests/<date>.md` + `latest.json`. Point cron/launchd at it:

```
40 6 * * * /usr/local/bin/jobsweep digest > /dev/null 2>&1
```

Add `--rank` to have the model review only the new postings each morning. For an always-on dashboard, run `jobsweep serve` under launchd/systemd the same way.

## Security and data handling

- **Local only.** No hosted component. The server binds loopback. Nothing leaves the machine except requests to the job sources you enabled and, only if you configured one, the model provider — and for the interview, only after you said *Continue*.
- **Secrets** stay in `~/.config/jobsweep/.env`; never in the repo, the profile, or a URL.
- **Fetched content is data, not instructions** — see the prompt-injection notes above.
- **Export safety:** CSV formula injection neutralised; only `http(s)` URLs exported.
- **Bounded runs:** one dashboard-triggered search at a time, killed after 15 minutes; LinkedIn concurrency capped at 2 with backoff.
- **Schema migrations** are explicit and transactional (e.g. the `runs` table gained an id; existing rows are copied, never dropped).

## Develop

```sh
bun install
bun test            # 152 tests, all offline (a scripted local model server stands in for the real one)
bun run typecheck
bun run build       # dist/ binaries for mac/linux/windows
bun run smoke       # drives the compiled binary end-to-end: PDF resume → interview → rank → ui
```

Layout: `src/providers/*` one file per source behind a common `Provider` interface (`search`, `detail`, `revalidate`); `src/filters.ts` city/comp/years/dedupe; `src/text.ts` the parsers; `src/run.ts` the sweep + carry-forward; `src/db.ts` the store; `src/serve.ts` + `src/dashboard.ts` + `src/ui.ts` the pages; `src/export.ts`; `src/llm.ts` + `src/interview.ts` + `src/rank.ts` the model layer; `presets/swe.json` the title gate and default queries; `prompts/*.md` the prompts, bundled into the binary.

CI typechecks and runs the suite on every push; tagging `v*` builds and attaches the five binaries to a GitHub Release.

MIT.
