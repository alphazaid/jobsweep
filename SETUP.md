# Setting up jobsweep — for an AI agent (or anyone)

You are setting up jobsweep on the user's machine so that afterwards they can say "find me jobs", "rank them", or "open the dashboard" to you and it works. This page is the whole procedure. Humans who'd rather not involve an agent: run `jobsweep init` and answer the prompts; it does the same thing interactively.

**Done means:** `jobsweep doctor` exits 0, a first search has run, and the jobsweep skill is installed where your harness reads skills. Nothing else counts.

## Rules

- **Ask before you assume.** Cities, comp floor, and years of experience are the user's to state. Ask for them if they haven't said (one message, all three). Everything else has a sensible default.
- **Never invent credentials, never put them on a command line.** Adzuna and model keys are optional. If the user gives you one, it goes into `~/.config/jobsweep/.env` (see step 3), not into a flag — flags end up in shell history and process listings.
- **LinkedIn stays off unless the user opts in** after reading the notice below — it's their terms-of-service risk, not yours.
- **Nothing you do here leaves the machine** except requests to the job sources during the first search.
- **Verify with `jobsweep doctor`, not by assertion.** Every step below ends in a check you can run.

## 1. Get the CLI on PATH

```sh
jobsweep --version
```

If that fails:

- With [Bun](https://bun.sh) installed: `bun install -g jobsweep`
- Otherwise download the binary for this OS from the Releases page of the jobsweep repository, `chmod +x` it, and put it on PATH as `jobsweep` (e.g. `/usr/local/bin/jobsweep`).
- From a source checkout: `bun install` in the repo, then use `bun run /abs/path/src/cli.ts` in place of `jobsweep` throughout — the skill installer records whichever launcher you used.

Check: `jobsweep --version` prints a version.

## 2. Collect four things from the user

| Ask | Flag | Example | Default if they shrug |
|---|---|---|---|
| What kind of role? | `--preset` | `swe`, `data`, `devops-sre`, `security`, `product`, `design`, `marketing`, `sales`, `finance`, `healthcare`, `legal`, `hr-recruiting`, `any` (`jobsweep presets` describes each) | `swe` — but ask; a nurse with the SWE gate finds nothing |
| Which cities? | `--cities` | `"New York, NY;Austin, TX"` (separate with `;`) | none — required |
| Comp floor (the top of a posted band must clear it)? | `--min-tc` | `200k` | none (all comp kept) |
| Most years of experience a posting may require? | `--max-yoe` | `3` | none |

Optional, mention only if relevant: skills to score against (`--skills "Go,TypeScript,AWS"`), remote (`--remote include|only|exclude`, default include = city + remote-US), recency (`--days 14`).

## 3. Write the profile (no prompts)

```sh
jobsweep init --preset swe --cities "New York, NY" --min-tc 200k --max-yoe 3 --skills "TypeScript,Go,AWS" --json
```

Preview first with `--dry-run`: it validates the flags and prints the exact profile it would write (and which files) without touching anything — show that to the user and get a yes before running it for real. Then the same command without `--dry-run` writes `profile.json` and a seed `companies.json` under `~/.config/jobsweep`, and installs the agent skill (step 6) unless `--no-skill`. `--json` prints the paths written (never secrets). Re-running with fewer flags keeps existing values.

**Adzuna** (optional, free official API — https://developer.adzuna.com). If the user has an app id and key, write them to the secrets file yourself, then run `init` (it reads them from the environment or that file and enables the source):

```sh
mkdir -p ~/.config/jobsweep
printf 'ADZUNA_APP_ID=%s\nADZUNA_APP_KEY=%s\n' "$ID" "$KEY" > ~/.config/jobsweep/.env   # or edit the file with an editor
chmod 600 ~/.config/jobsweep/.env
jobsweep init --cities "New York, NY"      # picks the keys up; `sources` now includes adzuna
```

Model keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) go in the same file, same way, only if the user wants `interview`/`rank` against a hosted model. Not needed for you to rank — see the installed skill.

**LinkedIn** (off by default): show the user this notice verbatim, and add `--linkedin` only if they say yes:

> LinkedIn has no public job API. The connector reads LinkedIn's public guest job pages from your machine, which LinkedIn's terms prohibit doing automatically. It runs only locally, keeps volume low, and you use it at your own risk for your own personal search.

Check: `jobsweep doctor` shows `ok profile` and `ok companies`.

## 4. Discover company boards for their cities

```sh
jobsweep companies discover
```

Adds every Greenhouse/Lever/Ashby board found hiring in the user's cities (2–3 minutes, network). Run it once; the seed alone is a small default list.

Check: `doctor`'s `companies` line no longer says "seed only".

## 5. First search

```sh
jobsweep search
```

Takes about a minute the first time (boards are fetched and cached). Prints the matches table. If it reports `Sources skipped`, read the reason — a source being down is not a setup failure.

Check: `jobsweep doctor` shows `ok search · last search <today>: N open`.

## 6. Install the skill (so the user can just ask you)

Done by step 3 unless you passed `--no-skill`. To do it explicitly, or to target a harness that keeps skills somewhere specific:

```sh
jobsweep skill --install                      # ~/.agents/skills/jobsweep (+ ~/.claude/skills/jobsweep if ~/.claude exists)
jobsweep skill --install --dir <skills-root>  # any other skills directory your harness scans
```

The installed `SKILL.md` carries the launcher for this machine. Read it: it is what you will follow from now on.

Check: `jobsweep doctor` shows `ok skill` with the path.

## 7. Optional: run it on a schedule

Only if the user asks. Modifies their OS scheduler (launchd / systemd user timer / Task Scheduler).

```sh
jobsweep schedule --daily 06:40     # or --every 6h
jobsweep schedule --status
```

## 8. Optional: dashboard

```sh
jobsweep serve --open     # http://127.0.0.1:4747 — stats, run button, triage page, CSV/JSON export
```

## Finish

```sh
jobsweep doctor
```

Exit 0 and every required line `ok` → tell the user setup is complete, quote the `profile` line back to them so they can confirm the cities/floor/years, and offer the three things they can now say: *find me jobs*, *rank them*, *open the dashboard*. Any `FAIL` line names its fix; do that, re-run `doctor`, then report.

## Troubleshooting

| Symptom | Meaning | Do |
|---|---|---|
| `{"error":"…","code":"NO_CITY"}` | no cities in profile or flags | step 3 with `--cities` |
| `NO_SEARCH` | a command needs a search first | `jobsweep search` |
| `LINKEDIN_OPT_IN_ERROR` | LinkedIn in sources without consent | drop it, or ask the user and add `--linkedin` |
| `Sources skipped: adzuna` | keys not set | fine; optional |
| `doctor` says skill STALE | placeholders unfilled | `jobsweep skill --install` |
| `EPERM` under `~/Desktop` or `~/Documents` on macOS | iCloud evicted the folder | move the checkout elsewhere (e.g. `~/Projects`) |
