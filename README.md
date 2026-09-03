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
- [Running it on a schedule](#running-it-on-a-schedule)
- [Security and data handling](#security-and-data-handling)
- [Develop](#develop)

## Install

Either way, the goal is a `jobsweep` on your PATH — the skill and every example below assume it.

```sh
bun install -g jobsweep        # with Bun (https://bun.sh); puts `jobsweep` on PATH
```

Or download a prebuilt binary for macOS (arm64/x64), Linux (arm64/x64), or Windows (x64) from the [Releases](../../releases) page — no runtime needed — and put it somewhere on your PATH as `jobsweep`. (`bunx jobsweep init` works for a one-off try, but it doesn't leave a `jobsweep` behind; the installed skill then embeds the full path of whatever ran, which is fine on this machine but not the intent.)

## Quickstart

Two ways in — same result:

- **Yourself:** `jobsweep init` asks eight questions and writes your profile.
- **Hand it to your AI agent:** paste *"Set up jobsweep by following https://github.com/alphazaid/jobsweep/blob/main/SETUP.md"* into Claude Code, Codex, Cursor, OMP, or any agent with a shell. [SETUP.md](SETUP.md) is written for it: it asks you for your cities, comp floor, and years, runs the unattended `jobsweep init --cities … --min-tc … --max-yoe …`, discovers boards, runs the first search, installs the skill, and proves each step with `jobsweep doctor`. (Also available offline as `jobsweep setup-guide`.)

### By hand

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
| `jobsweep init --cities "…" [--min-tc 200k] [--max-yoe 3] [--skills "…"] [--linkedin] [--no-skill] [--json]` | The same setup with no prompts, for scripts and agents. Adzuna keys are read from `ADZUNA_APP_ID`/`ADZUNA_APP_KEY` in the environment, never flags. |
| `jobsweep doctor [--json]` | Check the setup: profile, boards, keys, skill, last search, schedule. Exit 1 if anything required is missing; each failing line names its fix. |
| `jobsweep setup-guide` | Print SETUP.md — the agent-followable setup procedure. |
| `jobsweep search [flags]` | The sweep. Flags override the profile; with a profile, no flags needed. Writes `digests/last-search.json` and records a run. |
| `jobsweep serve [-p 4747] [--open]` | Local dashboard server (see [Dashboard](#dashboard)). `-s` prints a console summary, `-j` the same as JSON, no server. |
| `jobsweep export [--csv\|--json] [--out <file>]` | Every posting from the last search with comp, years, fit, AI review, your decision, URL (see [Export](#export)). |
| `jobsweep ui [--open]` | Standalone one-file triage page (`~/.config/jobsweep/ui/jobs-<date>.html`) — works offline with marks in the browser's localStorage. The served `/triage` page is the same UI with marks kept server-side. |
| `jobsweep digest [--top <n>] [--rank] [--notify]` | Run the profile, write `digests/<date>.md` + `latest.json`, print the digest; `--notify` posts a desktop notification when there are new postings. What `schedule` runs. |
| `jobsweep schedule --every <30m\|6h\|1d> \| --daily HH:MM` | Run the digest on an OS timer (launchd / systemd user timer / Task Scheduler). `--status`, `--remove`. |
| `jobsweep detail <id>` | Full posting JSON, e.g. `greenhouse:stripe:7532733`, `linkedin:4300011451`. |
| `jobsweep companies [--verify]` | List company boards; `--verify` hits each one live (never touches the cache). |
| `jobsweep companies discover` | Add every Greenhouse/Lever/Ashby board hiring in your cities, found via freehire. Agency/aggregator boards are skipped. |
| `jobsweep cache [clear]` | Show cache size, or drop cached feeds (postings and their seen-dates are kept). |
| `jobsweep skill [--install] [--dir <path>]` | Print the agent skill, or install it into `~/.agents/skills` (+ `~/.claude/skills`) with this machine's launcher filled in. |
| `jobsweep review --pending [--limit 12] [--new]` | Next unreviewed postings as JSON, trimmed for judging — the agent's batch loop. |
| `jobsweep review [--model <name>]` | Attach reviews written by the calling agent — JSON on stdin or `--id --fit --reason`. No key needed. |
| `jobsweep review --clear <id>… \| --clear-all` | Retract reviews (agent or model). |
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

## Use it from your coding agent

The intended way to use jobsweep day to day: set it up once, then just ask your agent.

```sh
jobsweep skill --install      # init offers this too
```

That writes an [Agent Skill](https://agentskills.io) — a `SKILL.md` in the format every skills-aware agent reads — to `~/.agents/skills/jobsweep/` (the cross-client convention the spec's integration guide recommends; Claude Code, Codex, Cursor, OMP and others scan it) and, if `~/.claude` exists, `~/.claude/skills/jobsweep/` (Claude Code's own location). Your agent keeps skills somewhere else? `jobsweep skill --install --dir <that-skills-root>`. The launcher for *this* machine is filled in: `jobsweep` if it's on your PATH, else the shell-quoted absolute path of the binary or `bun run …/src/cli.ts`. Then, in any of those agents:

> find me jobs · what's new · jobs in Austin paying 180k+ · which of these should I apply to · rank them · open the dashboard · export the list

…and the agent runs the CLI, reads the JSON, and answers from it. **Ranking needs no API key**: the agent you're already talking to *is* the model. The skill has it work in bounded batches — `jobsweep review --pending --limit 12` hands it the next twelve unreviewed postings (comp ceiling first, `--new` for today's only, descriptions trimmed), it judges them, and hands verdicts back with `jobsweep review` — reporting progress (`reviewed 24 of 349`) rather than pretending to have read all 349. Verdicts land on the dashboard, the triage page, and exports exactly as a configured model's would:

```sh
jobsweep review <<'EOF'
{"results":[{"id":"greenhouse:acme:123","fit":4,"reason":"Backend Go, 2+ yrs, $210k top clears the floor.","dealbreakers":[],"emphasize":["payments experience"]}]}
EOF
jobsweep review --id linkedin:4455 --fit 1 --reason "Requires active TS/SCI clearance." --dealbreaker clearance
```

Reviews are validated and bounded like `rank`'s (fit 1–5, reason ≤ 600 chars), stored in their own SQLite table (never touched by cache pruning or `cache clear`), and re-attached on every later `search` until the posting's content changes. Retract with `jobsweep review --clear <id>` or `--clear-all`. `jobsweep skill` (no `--install`) prints the skill so you can read what the agent will be told.

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
| `jobsweep.db` | SQLite: seen postings, feed cache, run history, decisions, reviews (model and agent; never pruned) |
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

## Running it on a schedule

```sh
jobsweep schedule --daily 06:40     # or --every 6h · --every 1d · --every 30m (15m minimum)
jobsweep schedule --status
jobsweep schedule --remove
```

Uses what the OS already has — a launchd agent on macOS (`~/Library/LaunchAgents/com.jobsweep.digest.plist`), a systemd user timer on Linux (`~/.config/systemd/user/jobsweep-digest.timer`), Task Scheduler on Windows — so nothing of jobsweep's stays resident: the OS wakes the CLI, it runs `jobsweep digest --notify`, it exits. The launcher is written as an absolute path (schedulers run with almost no `PATH`). Each run writes `digests/<date>.md` + `latest.json`, records a row for the dashboard's history chart, and posts a desktop notification only when it found something ("3 new postings · 349 open"; macOS, and Linux with `notify-send`) — a quiet run stays quiet. Output goes to `~/.config/jobsweep/digests/schedule.log` (`journalctl --user -u jobsweep-digest` on Linux). Re-running `schedule` replaces the previous timer.

Prefer your own cron? `jobsweep digest` is the command to point it at. Add `--rank` to have a configured model review only the new postings each run. For an always-on dashboard, run `jobsweep serve` under the same scheduler with a keep-alive, or just leave it in a terminal.

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
bun test            # 182 tests, all offline (a scripted local model server stands in for the real one)
bun run typecheck
bun run build       # dist/ binaries for mac/linux/windows
bun run smoke       # drives the compiled binary end-to-end: PDF resume → interview → rank → ui
```

Layout: `src/providers/*` one file per source behind a common `Provider` interface (`search`, `detail`, `revalidate`); `src/filters.ts` city/comp/years/dedupe; `src/text.ts` the parsers; `src/run.ts` the sweep + carry-forward; `src/db.ts` the store; `src/serve.ts` + `src/dashboard.ts` + `src/ui.ts` the pages; `src/export.ts`; `src/schedule.ts` the OS timers; `src/init.ts` (one `writeSetup` core behind the prompts and the flags) + `src/doctor.ts`; `src/llm.ts` + `src/interview.ts` + `src/rank.ts` the model layer; `presets/swe.json` the title gate and default queries; `prompts/*.md` the prompts and `skill/SKILL.md` the agent skill, both bundled into the binary.

CI typechecks and runs the suite on every push; tagging `v*` builds and attaches the five binaries to a GitHub Release.

MIT.
