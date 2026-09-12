// Fetches English league results + upcoming fixtures from football-data.co.uk,
// parses the CSVs and returns compact JSON.
//
// GET /.netlify/functions/data           -> current + previous season
// GET /.netlify/functions/data?seasons=3 -> current + two previous

// Canonical host — www redirects here, and the extra hop is one more thing
// for an anti-scraping layer to object to.
const BASE = 'https://football-data.co.uk';
const DIVISIONS = ['E0', 'E1', 'E2', 'E3'];

const DIV_NAMES = {
  E0: 'Premier League',
  E1: 'Championship',
  E2: 'League One',
  E3: 'League Two',
};

// --- season codes -----------------------------------------------------------

// A season is labelled by the calendar year it starts in. English football
// starts in August, so anything before July belongs to the previous season.
function currentSeasonStartYear(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1;
}

// 2026 -> "2627"
function seasonCode(startYear) {
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return a + b;
}

function seasonLabel(startYear) {
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// --- CSV parsing ------------------------------------------------------------

// Minimal RFC4180-ish parser. The source files are mostly plain, but referee
// and team fields occasionally carry quotes, so don't just split on commas.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }

  row.push(field);
  rows.push(row);

  if (!rows.length) return [];

  // Strip a UTF-8 BOM if one survived the decode.
  const header = rows[0].map((h) => h.replace(/^\uFEFF/, '').trim());

  return rows
    .slice(1)
    .filter((r) => r.some((v) => v !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => {
        if (h) obj[h] = (r[i] ?? '').trim();
      });
      return obj;
    });
}

// --- field coercion ---------------------------------------------------------

// Source dates are dd/mm/yyyy, with dd/mm/yy in some older files.
function toIsoDate(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  return `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function toInt(raw) {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function toFloat(raw) {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Team names arrive consistently across files, but whitespace does drift.
function normaliseTeam(raw) {
  return (raw || '').replace(/\s+/g, ' ').trim();
}

// --- fetching ---------------------------------------------------------------

// Source files are Windows-1252, not UTF-8.
async function fetchCsv(url) {
  // The whole function is capped at 10s, so no single file gets more than 7.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  let res;
  try {
    res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // A bare script user-agent gets refused by some static hosts.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/csv,text/plain,*/*',
        'Accept-Language': 'en-GB,en;q=0.9',
        // The download links live on this page; a missing referer is another
        // thing anti-scraping filters look at.
        'Referer': 'https://www.football-data.co.uk/englandm.php',
      },
      redirect: 'follow',
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'timed out after 7s' : err.message);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const buf = Buffer.from(await res.arrayBuffer());

  // TextDecoder needs a full-ICU build for legacy encodings. latin1 differs
  // only in the 0x80-0x9F range, which English team names never touch.
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

function toMatch(row, div, season) {
  const date = toIsoDate(row.Date);
  const home = normaliseTeam(row.HomeTeam);
  const away = normaliseTeam(row.AwayTeam);
  const hg = toInt(row.FTHG);
  const ag = toInt(row.FTAG);

  if (!date || !home || !away || hg === null || ag === null) return null;

  return {
    div,
    season,
    date,
    home,
    away,
    hg,
    ag,
    hs: toInt(row.HS),
    as: toInt(row.AS),
    hst: toInt(row.HST),
    ast: toInt(row.AST),
    // Closing totals prices. The backtest grades the model against these —
    // they're the same goal expectancy BTTS depends on, and unlike BTTS the
    // market for them is in this file.
    o25: toFloat(row['B365>2.5']) ?? toFloat(row['Avg>2.5']) ?? toFloat(row['BbAv>2.5']),
    u25: toFloat(row['B365<2.5']) ?? toFloat(row['Avg<2.5']) ?? toFloat(row['BbAv<2.5']),
  };
}

function toFixture(row) {
  const date = toIsoDate(row.Date);
  const home = normaliseTeam(row.HomeTeam);
  const away = normaliseTeam(row.AwayTeam);

  if (!date || !home || !away) return null;

  return {
    div: row.Div,
    date,
    time: row.Time || null,
    home,
    away,
    // Closing-ish prices for the sanity check in phase 2.
    oddsH: toFloat(row.B365H) ?? toFloat(row.AvgH),
    oddsD: toFloat(row.B365D) ?? toFloat(row.AvgD),
    oddsA: toFloat(row.B365A) ?? toFloat(row.AvgA),
    over25: toFloat(row['B365>2.5']) ?? toFloat(row['Avg>2.5']),
    under25: toFloat(row['B365<2.5']) ?? toFloat(row['Avg<2.5']),
  };
}

// --- handler ----------------------------------------------------------------

exports.handler = async (event) => {
  const requested = Number(event?.queryStringParameters?.seasons);
  const seasonCount = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), 1), 6)
    : 2;

  const startYear = currentSeasonStartYear();
  const seasons = [];
  for (let i = 0; i < seasonCount; i++) {
    const y = startYear - i;
    seasons.push({ startYear: y, code: seasonCode(y), label: seasonLabel(y) });
  }

  const errors = [];
  const matches = [];

  const jobs = [];
  for (const season of seasons) {
    for (const div of DIVISIONS) {
      const url = `${BASE}/mmz4281/${season.code}/${div}.csv`;
      jobs.push(
        fetchCsv(url)
          .then((text) => {
            for (const row of parseCsv(text)) {
              const m = toMatch(row, div, season.label);
              if (m) matches.push(m);
            }
          })
          .catch((err) => {
            // An empty file at the very start of a season is normal, so a
            // failure here shouldn't take the whole response down.
            errors.push({ url, message: err.message });
          })
      );
    }
  }

  let fixtures = [];
  jobs.push(
    fetchCsv(`${BASE}/fixtures.csv`)
      .then((text) => {
        fixtures = parseCsv(text)
          .filter((row) => DIVISIONS.includes(row.Div))
          .map(toFixture)
          .filter(Boolean);
      })
      .catch((err) => {
        errors.push({ url: `${BASE}/fixtures.csv`, message: err.message });
      })
  );

  await Promise.all(jobs);

  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  fixtures.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const e of errors) console.error('fetch failed', e.url, e.message);

  // Always 200, even with nothing to show. A non-200 gets swallowed by
  // Netlify's own error page and the reason never reaches the browser.
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Results change twice a week, but fixtures.csv fills up through the
      // week, so an hour is the useful ceiling here.
      'Cache-Control': matches.length
        ? 'public, max-age=3600, stale-while-revalidate=86400'
        : 'no-store',
    },
    body: JSON.stringify({
      fetchedAt: new Date().toISOString(),
      seasons: seasons.map((s) => s.label),
      divisions: DIV_NAMES,
      matches,
      fixtures,
      errors,
    }),
  };
};
