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

Run `jobsweep search` again tomorrow: new postings are starred, everything you've already seen is remembered, and the triage page keeps your apply/skip marks.

## What it searches

| Source | How | Comp data | Notes |
|---|---|---|---|
| Greenhouse, Lever, Ashby boards | each company's public board API | Ashby/Lever structured; Greenhouse parsed from text | `companies discover` finds boards for your cities via freehire; `companies --verify` checks them |
| Adzuna | official API, your free key | posted or estimated (marked `est`) | https://developer.adzuna.com |
| freehire.me | public API | enrichment | tech-only aggregator; also the discovery source for boards |
| LinkedIn | **off by default** — see below | parsed from the posting | |

### LinkedIn

LinkedIn has no public job API. The connector reads LinkedIn's public guest job pages from your machine, which LinkedIn's terms prohibit doing automatically. It is therefore **off unless you turn it on** (`jobsweep init` asks; or `--linkedin` per run), it only ever runs locally, keeps volume low (2 requests in flight, backoff, 14-day cache), and you use it at your own risk for your own personal search. Don't run it from a shared server or on behalf of other people.

## How filtering works

- **Title gate.** Every result must look like an IC software role (`presets/swe.json`): "Backend Engineer", "Member of Technical Staff", "Founding Engineer" pass; Sales/Solutions/QA/Hardware/DevOps/ML/Recruiter titles don't. Override with `titlePattern` in the profile or `--title-re`.
- **Comp.** `minTc` is compared to the **top** of the posted band. Postings that state no pay are kept in their own section, never silently dropped — outside NY/CA/WA/CO most companies don't post it. `--strict-comp` drops them.
- **Years.** The first "N+ years … experience" requirement is parsed (largest one inside a qualifications block). Unstated → inferred from the title (entry 0 / mid 2 / senior 5 / staff-lead-manager 8).
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

## Develop

```sh
bun install
bun test            # 112 tests, all offline
bun run typecheck
bun run build       # dist/ binaries for mac/linux/windows
```

MIT.
