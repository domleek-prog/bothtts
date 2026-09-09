# Both teams to score — phase 2

Poisson attack/defence ratings for the English leagues (Premier League,
Championship, League One, League Two), with the phase 1 baselines kept
alongside as the benchmark.

## Running it

```
npm i -g netlify-cli      # once
netlify dev               # serves index.html and the function together
```

Opening `index.html` from disk won't work — the page needs the function to get
round the source's CORS policy.

To deploy: push to a Git repo, connect it in Netlify. No environment variables.
`netlify.toml` pins Node 20, which the function needs for global `fetch`.

## The data layer

`netlify/functions/data.js` pulls nine CSVs from football-data.co.uk — four
divisions across two seasons plus the fixtures file — decodes them from
Windows-1252 and returns JSON, cached for six hours.

The source refuses requests that look automated, so the function sends a
browser user-agent and a referer, and uses the canonical host to avoid a
redirect hop. Removing any of those brings back a blanket 503.

## The model

Goals are modelled as independent Poissons:

```
home goals ~ Poisson(mu * attack(home) * defence(away) * homeEdge)
away goals ~ Poisson(mu * attack(away) * defence(home))
```

Attack above 1 means a side scores more than its division average; defence
above 1 means it lets in more. Both are normalised to a division mean of 1,
so `mu` stays readable as goals per team per game.

Fitted by iterative proportional fitting — 60 passes of multiplicative updates,
re-normalising each pass and re-estimating the home edge. Optional exponential
time decay downweights older matches by half-life.

Ratings are shrunk toward the division average by `w / (w + 4)`, where `w` is
the team's weighted match count. Six games into a season that pulls a rating
about 40% of the way back to average, which is roughly the right amount of
scepticism.

**Divisions are fitted separately.** There are no matches between divisions in
this dataset, so a Premier League attack rating and a League Two one are not on
a common scale and cannot be made so from results alone.

Probabilities use closed forms rather than a score matrix:

```
P(both score) = (1 - e^-lh)(1 - e^-la)
P(over 2.5)   = 1 - Poisson CDF(2; lh + la)
```

Verified against a 400,000-run Monte Carlo: 54.3% vs 54.3% for BTTS.

## Sanity checks in the interface

The strip shows the fitted home scoring edge and the average gap between the
model's over-2.5 number and the market's margin-stripped price. That second
figure is the calibration check — the market is efficient on totals, so a
persistent gap of more than a couple of points means the lambdas are off.

## Known limits

- Goals aren't really independent. Low-scoring games are correlated, and the
  affected scorelines are exactly the ones that decide BTTS. Phase 3.
- Promoted and relegated teams start from their new division's average rather
  than a level-adjusted carry-over of last season's rating. Flagged as **moved**.
- No backtest yet, so there's no evidence the model beats the baselines.
  Phase 4, and it's the phase that matters.

## Next

3. Dixon-Coles low-score correction, cross-division prior blending
4. Backtest harness, calibration curve, Brier and log loss
5. Manual BTTS odds entry, value column, prediction log
