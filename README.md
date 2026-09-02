# jobsweep

Sweep hundreds of company job boards, Adzuna, and freehire for software engineering roles that match **your city, comp floor, and years of experience** — then triage them in a one-file page with keyboard shortcuts. Runs on your machine. No account, no server, no telemetry.

```
$ jobsweep search
MATCHES (comp posted, sorted by ceiling)  * = new since last run  ° = carried from an earlier run
   FIT    TITLE                                     COMPANY               LOCATION                COMP          YOE       POSTED      SRC
*  5/18   Software Engineer, Full Stack             Plaid                 New York City Metro…    $176k–$227k   2+        2026-08-21  li
   6/18   Software Engineer III                     Garner Health         New York, NY            $194k–$220k   2+        2026-08-23  li
   …
117 with posted comp, 233 comp unknown, 1 new since last run, 31 carried from earlier runs · dropped: city 1647, tc 459, experience 835, excluded 102
```

## Install

Prebuilt binaries (no runtime needed) are on the [Releases](../../releases) page. Or with [Bun](https://bun.sh):

```sh
bunx jobsweep init
```

## Quickstart

```sh
jobsweep init                 # cities, comp floor, years, skills, sources, Adzuna key → ~/.config/jobsweep
jobsweep companies discover   # add every Greenhouse/Lever/Ashby board hiring in your cities (2–3 min, once)
jobsweep search               # the sweep
jobsweep ui --open            # triage page: j/k move · a apply · m maybe · x skip · d applied · o open
```

## With a model (optional)

Everything above is deterministic and free. Bring your own model key and two more commands turn on:

```sh
jobsweep interview --resume ~/resume.pdf   # builds candidate.md: reads your resume (pdf/md/txt), then asks
                                           # only what it can't know (targets, constraints, comp, timing)
jobsweep rank                              # scores the last search 1–5 against candidate.md, with reasons
jobsweep ui --open                         # rows now carry the fit, the reason, dealbreakers, what to lead with
jobsweep digest --rank                     # the daily digest reviews only what's new
```

- **Nothing is trusted silently.** The interview shows which files it read and asks before using them; the drafted profile is shown and you accept, correct, or redo it before it's saved; each suggested filter change is confirmed one by one.
- **LifeOS users:** if `~/.claude/LIFEOS` exists, your identity, resume, goals, and projects files are offered as interview context (`--no-lifeos` to skip).
- **Bounded spend:** `rank` reviews only postings that passed the mechanical filters and haven't been reviewed under this candidate profile + model before (cached in SQLite). `search` and plain `digest` never call a model.
- **Configure:** `JOBSWEEP_MODEL` or `"model"` in `profile.json` = `openai:<model>` or `anthropic:<model>`; keys in `~/.config/jobsweep/.env`: `OPENAI_API_KEY` (set `OPENAI_BASE_URL` for OpenRouter, Ollama, LM Studio) or `ANTHROPIC_API_KEY`. Prompts live in `prompts/` — read them, edit them.

Run `jobsweep search` again tomorrow: new postings are starred, everything you've already seen is remembered, and the triage page keeps your apply/skip marks.

## What it searches

| Source | How | Comp data | Notes |
|---|---|---|---|
| Greenhouse, Lever, Ashby boards | each company's public board API | Ashby/Lever structured; Greenhouse parsed from text | `companies discover` finds boards for your cities via freehire; `companies --verify` checks them |
| Adzuna | official API, your free key (https://developer.adzuna.com) | posted, or estimated (marked `est`) | on only when both keys are set |
| freehire.me | public JSON API (its `/agent/jobs/search` endpoint) | enrichment | open-source aggregator ("no walls", MIT backend, self-hostable via `FREEHIRE_API_URL`); it publishes no rate-limit terms, so keep volume modest |
| LinkedIn | **off by default** — see below | parsed from the posting | |

### LinkedIn

LinkedIn has no public job API. The connector reads LinkedIn's public guest job pages from your machine, which LinkedIn's terms prohibit doing automatically. It is therefore **off unless you turn it on** (`jobsweep init` asks; or `--linkedin` per run), it only ever runs locally, keeps volume low (2 requests in flight, backoff, 14-day cache), and you use it at your own risk for your own personal search. Don't run it from a shared server or on behalf of other people.

## How filtering works

- **Title gate.** Every result must look like an IC software role (`presets/swe.json`): "Backend Engineer", "Member of Technical Staff", "Founding Engineer" pass; Sales/Solutions/QA/Hardware/DevOps/ML/Recruiter titles don't. Override with `titlePattern` in the profile or `--title-re`.
- **Years.** The first "N+ years … experience" requirement is parsed (largest one inside a qualifications block). Unstated → inferred from the title (entry 0 / mid 2 / senior 5 / staff-lead-manager 8).
- **Age.** Company-board postings older than 90 days are never returned, whatever `days` says — boards keep evergreen reqs open for years. `days` narrows within that.
- **City.** Metro aliases (`src/metros.json`; add your own in `~/.config/jobsweep/metros.json`) so "New York" matches Brooklyn and Jersey City. Remote-US is included by default; `remote: only | exclude`.
- **Dedupe.** The same posting seen on LinkedIn, freehire, and the company's own board collapses to the copy with the best data; the company board wins over aggregators, which sometimes mislabel locations.
- **Memory.** Postings are remembered in SQLite. LinkedIn's search returns a different sample every call, so postings it showed you recently are carried forward (marked `°`) after being re-checked as still open.

## Profile

`~/.config/jobsweep/profile.json` (written by `init`; every key optional except `cities`):

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
  "linkedinAccepted": false
}
```

Unknown keys are rejected rather than silently ignored. Secrets go in `~/.config/jobsweep/.env` (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`). Set `JOBSWEEP_HOME` to move the whole config directory.

## Daily digest

`jobsweep digest` runs the profile and writes `digests/<date>.md` + `latest.json`. Point cron/launchd at it:

```
40 6 * * * /usr/local/bin/jobsweep digest > /dev/null 2>&1
```

## Dashboard and export

```sh
jobsweep serve --open     # http://127.0.0.1:4747 — stat cards, postings-per-run history, breakdowns by source /
                          # comp band / title band / company, decision funnel, "Run search now" with the live log,
                          # and the triage page with marks kept in SQLite (shared across browsers, exportable)
jobsweep export --csv --out jobs.csv   # every posting from the last search: comp, years, fit, AI review, your decision, URL
jobsweep export --json                 # same rows as JSON on stdout
```

The server binds `127.0.0.1` only. `/api/jobs.csv`, `/api/jobs.json`, `/api/decisions.json`, `/api/stats.json` are the same data over HTTP.

## Develop

```sh
bun install
bun test            # 140 tests, all offline (a scripted local model server stands in for the real one)
bun run typecheck
bun run build       # dist/ binaries for mac/linux/windows
```

MIT.
