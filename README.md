# Both teams to score — phase 1

Ingest layer and raw baseline for the English leagues (Premier League, Championship, League One, League Two).

## Running it

```
npm i -g netlify-cli      # once
netlify dev               # serves index.html and the function together
```

Opening `index.html` straight from disk won't work — the page needs the function
to get round the source's CORS policy. `netlify dev` proxies both on one origin.

To deploy: push to a Git repo, connect it in Netlify, accept the detected
settings. No environment variables and no build step.

## What it does

`netlify/functions/data.js` pulls nine CSVs from football-data.co.uk — four
divisions across two seasons, plus the upcoming fixtures file — decodes them
from Windows-1252, parses them and returns compact JSON. Responses are cached
for six hours; the source itself only updates a couple of times a week.

`index.html` holds everything else. It builds a per-team match index, computes
scoring and conceding rates over a chosen form window, and ranks the upcoming
fixtures. The last successful payload is kept in localStorage, so a reload is
instant and a failed fetch falls back to the saved copy rather than an empty
page.

## The two baseline numbers

**Scoring rate** treats the teams as independent: the home side's rate of
scoring in home matches, multiplied by the away side's rate of scoring in away
matches.

**Past BTTS** averages how often each team's own matches have finished with both
sides scoring.

Neither adjusts for opponent quality, so a team with an easy run of fixtures
will look better than it is. That's the whole reason phase 2 exists — these two
numbers are the benchmark the real model has to beat, not the product.

## Flags

- **moved** — the team appears in more than one division across the loaded
  seasons, so its older form came against different opposition.
- **thin** — fewer matches in the window than the minimum, currently 6.

## Next

2. Poisson attack/defence ratings, model probabilities per fixture
3. Dixon-Coles low-score correction, time decay, prior blending
4. Backtest harness, calibration curve, Brier and log loss
5. Manual BTTS odds entry, value column, prediction log
