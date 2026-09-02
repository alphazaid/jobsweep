Write the candidate profile from the context documents and the interview transcript. It will be read by a reviewer scoring job postings for this person, so be specific and factual; never invent.

Reply with a single JSON object:

{
  "candidate": "<markdown, 300-600 words: ## Now · ## Looking for · ## Non-negotiables · ## Preferences · ## Notes for a reviewer>",
  "profile": {
    "cities": ["<City, ST>", ...],
    "remote": "include" | "only" | "exclude",
    "minTc": <annual USD number the top of a posted band must clear, or null>,
    "maxYoe": <max years a posting may require, or null>,
    "skills": ["<skill exactly as it would appear in a posting>", ... up to 20],
    "exclude": ["<title word that disqualifies a posting>", ...],
    "queries": ["<search phrase>", ... 3-8]
  },
  "unknowns": ["<anything still unknown that a reviewer would want>", ...]
}

`profile` values are suggestions for the deterministic search filters; the person will confirm each one. `minTc` should be a little above their floor so borderline bands still show.
