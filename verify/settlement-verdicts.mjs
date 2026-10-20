// Per-market settlement verdicts recomputed from the SHIPPED archive files —
// the public settlement audit (outcometick.com/polymarket-settlement-audit).
//
// Same doctrine as audit check F (lib/audit-settlement.mjs, whose rule and
// TWAP classifier are reused, not copied), applied to the files a customer
// downloads instead of the live database, so every verdict on the page can be
// reproduced from the archive:
//   - the rule is read off each market (raw.cryptoMarketConfig), never the date;
//   - a verdict needs the EXACT boundary-second tick(s); a missing boundary
//     second is "insufficient evidence", never inferred from neighbours;
//   - TWAP markets with no TWAP stream archived for their window (2026-08-07)
//     fall back to F's approximation and are labelled mode 'approx'.
// It differs from F only where F would crash or go red on input it cannot use:
// those markets are reported as insufficient with a reason, because a public
// page lists every market rather than gating a release.
//
// Pure: no I/O. scripts/settlement-audit.mjs does the fetching and writing.

import {
  settlementRule, classifyTwapSettlement, resolutionLagMinutes,
} from './audit-settlement.mjs';

export const METHOD_VERSION = 1;

/** Why a market could not be settled from the archive. Stable codes: the page translates them. */
export const REASONS = Object.freeze([
  'official_unresolved',   // no complete official outcome pair in the markets file
  'rule_unsupported',      // a settlement config we do not collect a stream for
  'no_strike',             // instant rule: strike_value is null
  'boundary_missing_start',// stream flowing, but the start boundary second is absent
  'boundary_missing_end',  // stream flowing, but the end boundary second is absent
  'no_stream',             // no settlement-stream ticks at all around the market
  'approx_near_tie',       // approximation (no TWAP archive) too close to call
  'precision_unavailable', // the fixed-point value is missing or not at the 1e18 scale
  'invalid_input',         // the classifier refused the inputs (corrupt row)
  'feed_not_archived',     // Predict.fun: the market settles on a price source we do not archive (Binance)
]);

const INSTANT_SEARCH_MS = 10_000; // F: neighbours within 10s only tell "gap" from "no tick"

/** "btc" -> "BTCUSD": the settlement-stream symbol for a Polymarket market's asset. */
export const streamSymbol = (asset) => `${String(asset).toUpperCase()}USD`;

/** 300 -> "5m". Null for anything else (never guessed). */
export function intervalLabel(sec) {
  if (sec === 300) return '5m';
  if (sec === 900) return '15m';
  return null;
}

/**
 * Index one settlement stream's CSV rows (header-mapped objects).
 *
 * Two views, because F uses the rows two ways:
 *   byTs/sorted — one tick per feed second, the LATEST receipt winning (F's
 *                 `ORDER BY recv_ms DESC LIMIT 1` for a boundary second);
 *   all         — every valid row, duplicates kept, ordered by feed second (F's
 *                 window COUNT and AVG run over all rows, not one per second).
 * Rows that do not parse are dropped and counted, never coerced.
 */
export function indexStream(rows) {
  const byTs = new Map();
  const all = [];
  let bad = 0;
  for (const r of rows) {
    const ts = Number(r?.feed_ts_ms);
    const recv = Number(r?.recv_ms);
    const value = Number(r?.value);
    if (!Number.isSafeInteger(ts) || !Number.isFinite(value)) { bad++; continue; }
    const tick = { ts, value, fav: typeof r.full_accuracy_value === 'string' ? r.full_accuracy_value : '', recv };
    all.push(tick);
    const prev = byTs.get(ts);
    if (prev && !(recv > prev.recv)) continue;
    byTs.set(ts, tick);
  }
  const sorted = [...byTs.keys()].sort((a, b) => a - b);
  all.sort((a, b) => a.ts - b.ts);
  return { byTs, sorted, all, bad };
}

/** Every row (duplicates included) with lo < ts <= hi (F's lookback window), oldest first. */
function rowsIn(stream, loExclusive, hiInclusive) {
  const out = [];
  let lo = 0, hi = stream.all.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (stream.all[mid].ts <= loExclusive) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < stream.all.length && stream.all[i].ts <= hiInclusive; i++) out.push(stream.all[i]);
  return out;
}

/**
 * A tick's fixed-point value, or null when it is not one we can compare exactly.
 * The collector writes String(value) when the relay omits the 1e18 string and
 * the archive cannot tell the two apart, so a value must be all digits AND sit
 * at the 1e18 scale of its own float column.
 */
export function fixedPoint(tick) {
  const s = tick?.fav;
  if (typeof s !== 'string' || !/^\d+$/.test(s)) return null;
  const v = tick.value;
  if (!(v > 0) || Math.abs(Number(s) / 1e18 - v) > v * 1e-6) return null;
  return s;
}

/** Same check for a market's strike_value (no float column beside it: scale is checked against the end tick). */
function strikeFixed(strike, nearValue) {
  if (typeof strike !== 'string' || !/^\d+$/.test(strike)) return null;
  if (!(nearValue > 0) || Math.abs(Number(strike) / 1e18 - nearValue) > nearValue * 0.5) return null;
  return strike;
}

/** UP/DOWN from a complete binary pair, else null. */
export function officialOutcome(m) {
  if (m?.resolved !== true || !Array.isArray(m.outcome_prices) || m.outcome_prices.length !== 2) return null;
  const [a, b] = m.outcome_prices.map(String);
  if (a === '1' && b === '0') return 'UP';
  if (a === '0' && b === '1') return 'DOWN';
  return null;
}

const tickOut = (t) => (t ? { ts: t.ts, v: t.fav || String(t.value) } : null);

/**
 * The verdict for one Polymarket market.
 *
 * @param m        a markets-file row (slug, asset, interval_sec, start_sec, end_sec,
 *                 resolved, outcome_prices, strike_value, raw)
 * @param streams  { prices, twap30, twap60 } — indexStream() results for this
 *                 market's asset, covering the market's window (and its lookback)
 * @returns {{slug, asset, interval, start, end, rule, verdict, mode, reason, official, ours,
 *            startTick, endTick, strike, lateMin}}
 */
export function verdictForMarket(m, streams) {
  const cfg = m?.raw?.cryptoMarketConfig;
  const rule = settlementRule(cfg);
  const official = officialOutcome(m);
  const lag = resolutionLagMinutes(m?.raw?.closedTime, m?.end_sec);
  const base = {
    slug: m.slug, asset: String(m.asset).toUpperCase(), interval: intervalLabel(m.interval_sec),
    start: m.start_sec, end: m.end_sec,
    rule: rule.kind === 'twap' ? `twap${rule.lookbackSec}` : rule.kind,
    official, ours: null, mode: null, startTick: null, endTick: null,
    strike: typeof m.strike_value === 'string' ? m.strike_value : null,
    lateMin: lag == null ? null : Math.round(lag),
  };
  const insufficient = (reason, extra = {}) => ({ ...base, ...extra, verdict: 'insufficient', reason });
  const decided = (ours, mode, extra = {}) => ({
    ...base, ...extra, ours, mode, verdict: ours === official ? 'match' : 'mismatch', reason: null,
  });

  if (!official) return insufficient('official_unresolved');
  if (rule.kind === 'unsupported') return insufficient('rule_unsupported');
  const startMs = m.start_sec * 1000;
  const endMs = m.end_sec * 1000;

  if (rule.kind === 'twap') {
    const twap = rule.lookbackSec === 30 ? streams.twap30 : rule.lookbackSec === 60 ? streams.twap60 : null;
    if (!twap) return insufficient('rule_unsupported');
    const sT = twap.byTs.get(startMs) ?? null;
    const eT = twap.byTs.get(endMs) ?? null;
    const ticks = { startTick: tickOut(sT), endTick: tickOut(eT) };
    const lbMs = rule.lookbackSec * 1000;
    const hasStreamInWindow = rowsIn(twap, startMs - lbMs - 1, endMs).length > 0;
    if (sT && eT) {
      const s = fixedPoint(sT);
      const e = fixedPoint(eT);
      if (!s || !e) return insufficient('precision_unavailable', ticks);
    }
    let approxStart = null, approxEnd = null;
    if (!(sT && eT) && !hasStreamInWindow && streams.prices) {
      const mean = (lo, hi) => {
        const xs = rowsIn(streams.prices, lo, hi).map((t) => Number(fixedPoint(t) ?? NaN)).filter(Number.isFinite);
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      };
      approxStart = mean(startMs - lbMs, startMs);
      approxEnd = mean(endMs - lbMs, endMs);
    }
    const cls = classifyTwapSettlement({
      officialUp: official === 'UP',
      startFav: sT ? fixedPoint(sT) : null,
      endFav: eT ? fixedPoint(eT) : null,
      hasStreamInWindow, approxStart, approxEnd,
    });
    const extra = cls.mode === 'approx' ? {} : ticks;
    if (cls.verdict === 'agree' || cls.verdict === 'disagree') {
      const officialUp = official === 'UP';
      const oursUp = cls.verdict === 'agree' ? officialUp : !officialUp;
      return decided(oursUp ? 'UP' : 'DOWN', cls.mode, extra);
    }
    if (cls.verdict === 'indeterminate') {
      if (cls.mode === 'approx') return insufficient('approx_near_tie');
      return insufficient(sT ? 'boundary_missing_end' : 'boundary_missing_start', extra);
    }
    if (cls.verdict === 'noTick') return insufficient('no_stream');
    return insufficient('invalid_input', extra);
  }

  // Instant rule (markets that ended before 2026-08-07): Up iff the report at the
  // end boundary second >= strike_value. The exact second is required (F, 2026-06-21).
  // Checked in F's order (strike, then any tick nearby, then the exact second) so
  // the per-reason counts line up with F's for the same day.
  if (base.strike == null) return insufficient('no_strike');
  const prices = streams.prices;
  if (!prices) return insufficient('no_stream');
  const near = rowsIn(prices, endMs - INSTANT_SEARCH_MS, endMs + INSTANT_SEARCH_MS - 1);
  if (near.length === 0) return insufficient('no_stream');
  const eT = prices.byTs.get(endMs) ?? null;
  if (!eT) return insufficient('boundary_missing_end');
  const endTick = tickOut(eT);
  const e = fixedPoint(eT);
  const k = strikeFixed(base.strike, eT.value);
  if (!e || !k) return insufficient('precision_unavailable', { endTick });
  return decided(BigInt(e) >= BigInt(k) ? 'UP' : 'DOWN', 'exact', { endTick });
}

/**
 * Counts for a list of verdicts: overall and per "ASSET interval", each with
 * its own per-reason counts. Every market is counted exactly once — the page
 * must not show only the checkable subset. Groups carry everything a reader of
 * the index needs to re-total a subset (outcometick drops unlisted assets).
 */
export function summarize(verdicts) {
  const blank = () => ({ markets: 0, match: 0, mismatch: 0, insufficient: 0, approx: 0, byReason: {} });
  const totals = blank();
  const byGroup = {};
  for (const v of verdicts) {
    const key = `${v.asset} ${v.interval ?? '?'}`;
    const g = (byGroup[key] ??= blank());
    for (const t of [totals, g]) {
      t.markets++;
      t[v.verdict]++;
      if (v.mode === 'approx') t.approx++;
      if (v.reason) t.byReason[v.reason] = (t.byReason[v.reason] ?? 0) + 1;
    }
  }
  return { totals, byGroup };
}

// ------------------------------------------------------------- one archive day

/** Header-mapped rows of a settlement CSV (no quoted fields in these files). */
export function parseCsv(text) {
  const lines = text.split('\n');
  const header = lines[0].trim().split(',');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(',');
    const o = {};
    for (let j = 0; j < header.length; j++) o[header[j]] = cells[j];
    out.push(o);
  }
  return out;
}

export function parseJsonl(text, where) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { throw new Error(`${where}: unparsable JSONL line`); }
  }
  return out;
}

export const MARKETS_RE = /^data\/polymarket\/daily\/markets\/([A-Z0-9]+)-(5m|15m)\/[^/]+-markets-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/;
const STREAM_PATH = {
  prices: (sym, d) => `data/chainlink/daily/prices/${sym}/${sym}-prices-${d}.csv.gz`,
  twap30: (sym, d) => `data/chainlink-twap-30s/daily/prices/${sym}/${sym}-twap30s-prices-${d}.csv.gz`,
  twap60: (sym, d) => `data/chainlink-twap-60s/daily/prices/${sym}/${sym}-twap60s-prices-${d}.csv.gz`,
};
export const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** A verdict's `rule` -> the STREAM_PATH key it settles on. */
const RULE_STREAM = { instant: 'prices', twap30: 'twap30', twap60: 'twap60' };

/** Seconds in one UTC day: the denominator of the published coverage. */
export const DAY_SECONDS = 86_400;

/**
 * Whole seconds of the UTC day starting at `d0Sec` that carry at least one
 * archived report — audit check B's count(DISTINCT feed_ts_ms / 1000), taken
 * from the shipped file instead of the database. `seconds`: report times in
 * whole seconds, any order, duplicates allowed.
 */
export function coveredSeconds(seconds, d0Sec) {
  const seen = new Set();
  for (const s of seconds) if (s >= d0Sec && s < d0Sec + DAY_SECONDS) seen.add(s);
  return seen.size;
}

/**
 * Every Polymarket market that ENDED on `day` (end_sec in [day, day+1), F's
 * definition), with its verdict.
 *
 * The previous day's catalog supplies start ticks and lookbacks for markets
 * that straddle midnight, and markets listed only in its file; without it those
 * markets come out insufficient, never guessed. A market in both files takes
 * the later one (this day's), which is the fresher resolution.
 *
 * @param read  async (catalog, entry) => gunzipped text (the caller verifies sha256)
 * @returns {{verdicts: object[], inputs: {path:string, sha256:string}[]}}
 */
export async function auditDay({ day, catalog, prevCatalog = null, read, skipAssets = new Set() }) {
  const sources = [[prevCatalog, prevDay(day)], [catalog, day]].filter(([c]) => c && Array.isArray(c.files));
  const inputs = [];
  const take = async (c, entry) => { inputs.push({ path: entry.path, sha256: entry.sha256 }); return read(c, entry); };

  const assets = new Set();
  for (const f of catalog.files) {
    const m = MARKETS_RE.exec(f.path);
    if (m && !skipAssets.has(m[1])) assets.add(m[1]);
  }
  if (assets.size === 0) throw new Error(`${day}: no Polymarket markets files in the catalog`);

  const d0 = Date.parse(`${day}T00:00:00Z`) / 1000;
  const d1 = d0 + 86_400;
  const verdicts = [];
  const coverage = [];
  for (const asset of [...assets].sort()) {
    const sym = streamSymbol(asset);
    const streams = {};
    for (const [name, at] of Object.entries(STREAM_PATH)) {
      const rows = [];
      for (const [c, d] of sources) {
        const entry = c.files.find((f) => f.path === at(sym, d));
        if (entry) rows.push(...parseCsv(await take(c, entry)));
      }
      streams[name] = indexStream(rows);
    }
    const bySlug = new Map();
    for (const [c] of sources) {
      for (const entry of c.files) {
        const m = MARKETS_RE.exec(entry.path);
        if (!m || m[1] !== asset) continue;
        for (const row of parseJsonl(await take(c, entry), entry.path)) {
          if (typeof row?.slug === 'string') bySlug.set(row.slug, row);
        }
      }
    }
    // Coverage of every stream this asset's markets of the day settle on — not
    // of every stream archived: a retired stream's absence is not a gap.
    const used = new Set();
    for (const mk of bySlug.values()) {
      if (!(Number.isInteger(mk.end_sec) && mk.end_sec >= d0 && mk.end_sec < d1)) continue;
      const v = verdictForMarket(mk, streams);
      verdicts.push(v);
      if (RULE_STREAM[v.rule]) used.add(RULE_STREAM[v.rule]);
    }
    for (const name of [...used].sort()) {
      coverage.push({ asset, stream: name, seconds: coveredSeconds(streams[name].sorted.map((ms) => Math.floor(ms / 1000)), d0) });
    }
  }
  verdicts.sort((a, b) => a.end - b.end || (a.slug < b.slug ? -1 : 1));
  return { verdicts, inputs, coverage: { daySeconds: DAY_SECONDS, streams: coverage } };
}

// ------------------------------------------------------------- Predict.fun
//
// Predict publishes each market's start_price and end_price, and the outcome
// follows from them: Up when end > start, Down when end < start, TIE when equal
// (paid 50:50). There is no separate winner field, and `status` lags (a market
// with an end_price can still read OPEN), so the "official outcome" is the one
// those two published prices imply.
//
// What we recompute it from: the Chainlink stream Predict forwards, archived as
// data/predict-fun/prices/<SYM>/<SYM>-feed<id>-predict-prices-<day>.csv.gz.
// Measured on the 2026-09-08 sample: wherever the boundary second exists, the
// published price IS that stream's price at publish_time == start_sec/end_sec
// (722 of 722, compared at the published precision — the CSV carries float
// noise such as 79054.00499999999 for 79054.005). Hourly and daily markets name
// BINANCE as their provider; we do not archive that price, so they are listed
// as not settleable rather than guessed.

export const PREDICT_FEED_PROVIDER = 'CHAINLINK';

/** "hourly" -> "1h" (the API's names, same mapping as classifyPath). */
export function predictInterval(label) {
  const s = String(label ?? '').toLowerCase();
  if (s === 'hourly') return '1h';
  if (s === 'daily') return '1d';
  return /^\d+[mhd]$/.test(s) ? s : null;
}

/** Index a Predict price CSV by publish_time (seconds); the latest receipt wins. */
export function indexPredictStream(rows) {
  const byTs = new Map();
  const all = [];
  let bad = 0;
  for (const r of rows) {
    const ts = Number(r?.publish_time);
    const recv = Number(r?.recv_ms);
    const price = typeof r?.price === 'string' ? r.price.trim() : '';
    if (!Number.isSafeInteger(ts) || !/^\d+(\.\d+)?$/.test(price)) { bad++; continue; }
    const tick = { ts, price, recv };
    all.push(ts);
    const prev = byTs.get(ts);
    if (prev && !(recv > prev.recv)) continue;
    byTs.set(ts, tick);
  }
  all.sort((a, b) => a - b);
  return { byTs, all, bad };
}

/**
 * A price as an exact decimal string, or null.
 *
 * The CSV holds float64 renderings, so a published 79054.005 can appear as
 * 79054.00499999999. That noise lives past the 15th significant digit (float64
 * carries 15–17), so a value with more than 15 significant digits is rounded to
 * 15; anything shorter is taken exactly as written. The precision is a property
 * of float64, never of the market prices being audited — deriving it from the
 * published strings would let an omitted trailing zero ("100") round a real
 * 100.1 → 99.9 move into a tie.
 */
export function canonDecimal(s) {
  const t = String(s ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  if (t.replace('.', '').replace(/^0+/, '').length <= 15) return t;
  const r = Number(t).toPrecision(15);
  return /^\d+(\.\d+)?$/.test(r) ? r : null;
}

/** Compare two exact decimal strings: -1, 0 or 1. */
export function cmpDecimal(a, b) {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const places = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(places, '0'));
  const y = BigInt(bi + bf.padEnd(places, '0'));
  return x > y ? 1 : x < y ? -1 : 0;
}

const outcomeOf = (start, end) => ({ 1: 'UP', 0: 'TIE', '-1': 'DOWN' })[cmpDecimal(end, start)];

/** The verdict for one Predict.fun market. `streams` maps price_feed_id -> indexPredictStream(). */
export function predictVerdictForMarket(m, streams) {
  // Published prices are exact decimal strings; only the CSV needs canonDecimal.
  const pub = (v) => (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);
  const start = pub(m?.start_price);
  const end = pub(m?.end_price);
  const provider = String(m?.price_feed_provider ?? '').toUpperCase();
  const official = start && end ? outcomeOf(start, end) : null;
  const base = {
    slug: String(m?.category_slug ?? m?.market_id), marketId: m?.market_id ?? null,
    asset: String(m?.asset ?? '').toUpperCase(), interval: predictInterval(m?.interval_label),
    start: m?.start_sec, end: m?.end_sec, rule: provider.toLowerCase() || null,
    official, ours: null, mode: null, startTick: null, endTick: null,
    officialStart: start || null, officialEnd: end || null, lateMin: null,
  };
  const insufficient = (reason, extra = {}) => ({ ...base, ...extra, verdict: 'insufficient', reason });
  // Price source first: a Binance-priced market is outside the audit whether or
  // not its prices are out yet. Checking the outcome first labelled it
  // official_unresolved until its end_price landed, and the page counted it in
  // the denominator meanwhile (Codex 2026-10-10).
  if (provider !== PREDICT_FEED_PROVIDER) return insufficient('feed_not_archived');
  if (!official) return insufficient('official_unresolved');
  const stream = streams.get(String(m.price_feed_id));
  if (!stream) return insufficient('no_stream');
  const sT = stream.byTs.get(m.start_sec) ?? null;
  const eT = stream.byTs.get(m.end_sec) ?? null;
  const ticks = { startTick: sT ? { ts: sT.ts * 1000, v: sT.price } : null, endTick: eT ? { ts: eT.ts * 1000, v: eT.price } : null };
  if (!sT || !eT) {
    // Flowing around the market but missing a boundary second, or silent altogether.
    let lo = 0, hi = stream.all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (stream.all[mid] < m.start_sec) lo = mid + 1; else hi = mid; }
    const flowing = lo < stream.all.length && stream.all[lo] <= m.end_sec;
    if (!flowing) return insufficient('no_stream');
    return insufficient(sT ? 'boundary_missing_end' : 'boundary_missing_start', ticks);
  }
  const s = canonDecimal(sT.price);
  const e = canonDecimal(eT.price);
  if (!s || !e) return insufficient('invalid_input', ticks);
  const ours = outcomeOf(s, e);
  return {
    ...base, ...ticks, ours, mode: 'exact', reason: null,
    verdict: ours === official ? 'match' : 'mismatch',
    // the published prices themselves, not just the side they imply
    pricesAgree: cmpDecimal(s, start) === 0 && cmpDecimal(e, end) === 0,
  };
}

export const PREDICT_MARKETS_RE = /^data\/predict-fun\/markets\/predict-markets-\d{4}-\d{2}-\d{2}\.jsonl\.gz$/;
const PREDICT_PRICES_RE = /^data\/predict-fun\/prices\/([A-Z0-9]+)\/\1-feed(\d+)-predict-prices-(\d{4}-\d{2}-\d{2})\.csv\.gz$/;

/**
 * Every Predict.fun market that ENDED on `day`, with its verdict. Streams come
 * from this day and the previous one (a market can open before midnight); a
 * market listed in both files takes this day's row, which carries its end_price.
 */
export async function auditPredictDay({ day, catalog, prevCatalog = null, read, skipAssets = new Set() }) {
  const sources = [[prevCatalog, prevDay(day)], [catalog, day]].filter(([c]) => c && Array.isArray(c.files));
  const inputs = [];
  const take = async (c, entry) => { inputs.push({ path: entry.path, sha256: entry.sha256 }); return read(c, entry); };
  if (!catalog.files.some((f) => PREDICT_MARKETS_RE.test(f.path))) throw new Error(`${day}: no Predict.fun markets file in the catalog`);

  const rowsByFeed = new Map();
  for (const [c, d] of sources) {
    for (const entry of c.files) {
      const m = PREDICT_PRICES_RE.exec(entry.path);
      if (!m || m[3] !== d) continue;
      const list = rowsByFeed.get(m[2]) ?? [];
      list.push(...parseCsv(await take(c, entry)));
      rowsByFeed.set(m[2], list);
    }
  }
  const streams = new Map([...rowsByFeed].map(([id, rows]) => [id, indexPredictStream(rows)]));

  const byId = new Map();
  for (const [c] of sources) {
    for (const entry of c.files) {
      if (!PREDICT_MARKETS_RE.test(entry.path)) continue;
      for (const row of parseJsonl(await take(c, entry), entry.path)) {
        if (row?.market_id != null) byId.set(String(row.market_id), row);
      }
    }
  }
  const d0 = Date.parse(`${day}T00:00:00Z`) / 1000;
  const d1 = d0 + 86_400;
  const verdicts = [];
  // asset|feed of every in-audit (Chainlink-priced) market that ended this day; a
  // feed a market names but the archive lacks counts 0 seconds.
  const used = new Map();
  for (const mk of byId.values()) {
    const asset = String(mk.asset ?? '').toUpperCase();
    if (skipAssets.has(asset)) continue;
    if (!(Number.isInteger(mk.end_sec) && mk.end_sec >= d0 && mk.end_sec < d1)) continue;
    verdicts.push(predictVerdictForMarket(mk, streams));
    if (String(mk.price_feed_provider ?? '').toUpperCase() === PREDICT_FEED_PROVIDER && mk.price_feed_id != null) {
      used.set(`${asset}|${mk.price_feed_id}`, { asset, feed: String(mk.price_feed_id) });
    }
  }
  verdicts.sort((a, b) => a.end - b.end || (String(a.marketId) < String(b.marketId) ? -1 : 1));
  const coverage = [...used.values()]
    .sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : a.feed < b.feed ? -1 : 1))
    .map(({ asset, feed }) => ({ asset, stream: `feed${feed}`, seconds: coveredSeconds(streams.get(feed)?.all ?? [], d0) }));
  return { verdicts, inputs, coverage: { daySeconds: DAY_SECONDS, streams: coverage } };
}
