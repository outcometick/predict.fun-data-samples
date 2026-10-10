// Settlement-recompute rules for audit check F (pure functions, unit-tested).
//
// Polymarket switched the crypto updown settlement source at 2026-08-07 00:00
// UTC: from the instantaneous Chainlink Data Streams value at the boundary
// second to the Chainlink TWAP streams (30s lookback for 5m markets, 60s for
// 15m; per-market provenance raw.cryptoMarketConfig). The audit must therefore
// pick the rule PER MARKET from that config — never by date — so manual
// re-audits of historical days always apply the rule that actually settled
// each market.
//
// Evidence grades for TWAP markets:
//   exact  — we hold the TWAP stream's boundary-second ticks at BOTH start_sec
//            and end_sec: that is the pair the resolver compared, so a
//            disagreement is definitive (red).
//   (gap)  — the stream was flowing for this market's window but a boundary
//            second is missing: indeterminate, same doctrine as the
//            instantaneous rule (2026-06-22: neighbours are never proof).
//   approx — the TWAP stream has NO coverage for this market's window (the
//            2026-08-07..first-deploy days, before the twap topics were
//            collected): approximate both boundaries as the simple mean of
//            the ~1Hz instantaneous ticks over the lookback window. That
//            approximation tracks the official TWAP to ~1e-4 relative
//            (2026-08-07 full-day validation: 2545/2576 agree, every residual
//            disagreement < 5e-4 relative), so an approx disagreement inside
//            APPROX_REL_EPS is an expected near-tie (disclosed, not red) and
//            one beyond it means gross corruption (red).
export const TWAP_TOPICS = { 30: 'crypto_prices_twap_thirty', 60: 'crypto_prices_twap_sixty' };
export const APPROX_REL_EPS = 1e-3;

/**
 * Decide which settlement rule governs a market.
 * @param cfg raw.cryptoMarketConfig (may be null/undefined for pre-TWAP markets)
 * @returns {{kind:'instant'}|{kind:'twap',lookbackSec:number,source:string}|{kind:'unsupported',lookbackSec:unknown}}
 */
export function settlementRule(cfg) {
  if (cfg == null || typeof cfg !== 'object') return { kind: 'instant' };
  if (cfg.twapEnabled == null || cfg.twapEnabled === false) return { kind: 'instant' };
  // a truthy-but-not-boolean twapEnabled (schema drift, e.g. the string
  // "true") must not silently pick EITHER rule — recomputing under the wrong
  // rule produces confident nonsense; escalate as unsupported instead
  if (cfg.twapEnabled !== true) return { kind: 'unsupported', lookbackSec: cfg.twapLookbackSeconds };
  const lb = Number(cfg.twapLookbackSeconds);
  const source = TWAP_TOPICS[lb];
  // an unlisted lookback is a stream we do not collect — the market must NOT
  // silently fall back to the instantaneous rule (wrong rule = false red or,
  // worse, false green); the caller escalates it instead
  if (!source) return { kind: 'unsupported', lookbackSec: cfg.twapLookbackSeconds };
  return { kind: 'twap', lookbackSec: lb, source };
}

/**
 * Expected TWAP stream symbols per topic, derived from the day's markets —
 * NOT from COLLECT_ASSETS config (config drifts: the audit host's stale env
 * would silently shrink the expectation, recreating the exact blind spot this
 * closes). A twap-rule market ending in the audited day means its asset's
 * settlement stream MUST be present that day; a whole-day-missing symbol is a
 * customer-visible gap that per-row checks (which only see rows that exist)
 * can never catch (Codex 2026-08-08 round-2 high).
 * @param markets array of {asset, cfg} rows (cfg = raw.cryptoMarketConfig)
 * @returns {Record<string, Set<string>>} topic source -> set of "<asset>/usd"
 */
export function expectedTwapSymbolsBySource(markets) {
  const out = {};
  for (const m of markets ?? []) {
    if (typeof m?.asset !== 'string' || m.asset === '') continue;
    const rule = settlementRule(m.cfg);
    if (rule.kind !== 'twap') continue; // unsupported variants are F's red, not B2's
    (out[rule.source] ??= new Set()).add(`${m.asset}/usd`);
  }
  return out;
}

/**
 * Per-product-line TWAP provenance, for the day-level discovery guard.
 *
 * WHY IT IS NOT JUST "does the interval exist" (Codex 2026-08-16 round-2). The
 * retired lane in twapTopicPlan is only safe while an empty topic really means
 * "upstream migrated away". If gamma discovery kept writing the 5m market rows
 * but lost or malformed their raw.cryptoMarketConfig, the 30s topic would go
 * empty for a completely different reason — and a guard that only checks that
 * interval 300 exists would wave it through, because the 15m markets carry the
 * same assets and would keep the 60s topic asserting happily. So the guard has
 * to be about provenance: every required duration must still have at least one
 * market carrying a SUPPORTED twap rule.
 *
 * PARTIAL loss counts too (Codex 2026-08-16 round-3). "At least one twap row per
 * duration" is not enough: since 2026-08-07 EVERY updown market settles on TWAP,
 * so a single surviving 5m config while the other seven assets lost theirs is
 * already metadata loss — and the damage is silent, because rows without a
 * supported rule simply drop out of expectedTwapSymbolsBySource (shrinking the
 * expectation) while settlementRule() maps a null cfg to the instant rule for
 * historical compatibility, so check F would recompute them under the wrong
 * rule instead of flagging them.
 *
 * @param markets           rows of {interval_sec, cfg}
 * @param requiredIntervals durations that must exist, in seconds
 * @returns {{absent:number[], noTwap:number[], partial:Array<{interval:number,missing:number,total:number}>}}
 *          absent  — no market row at all for that duration
 *          noTwap  — rows exist but not one carries a supported twap rule
 *                    (missing cfg, twapEnabled false, or an uncollected lookback)
 *          partial — the duration has supported twap rows AND rows without one
 */
export function assessTwapProvenance(markets, requiredIntervals) {
  const byInterval = new Map();
  for (const m of markets ?? []) {
    // Strict number gate, never coercion: interval_sec arriving as a string
    // (a bigint cast dropped in SQL) must fail the guard closed rather than
    // silently match nothing and read as "no markets today".
    const iv = m?.interval_sec;
    if (typeof iv !== 'number' || !Number.isFinite(iv)) continue;
    const e = byInterval.get(iv) ?? { rows: 0, twap: 0 };
    e.rows++;
    if (settlementRule(m.cfg).kind === 'twap') e.twap++;
    byInterval.set(iv, e);
  }
  const absent = [];
  const noTwap = [];
  const partial = [];
  for (const iv of requiredIntervals ?? []) {
    const e = byInterval.get(iv);
    if (!e) absent.push(iv);
    else if (e.twap === 0) noTwap.push(iv);
    else if (e.twap < e.rows) partial.push({ interval: iv, missing: e.rows - e.twap, total: e.rows });
  }
  return { absent, noTwap, partial };
}

/**
 * How much authority check B2 may claim over one TWAP topic on the audited day.
 *
 * WHY (2026-08-16). B2's completeness assertions all rest on "some market that
 * settled today used this stream". Upstream migrated the 5m markets from the
 * 30s lookback to the 60s one over 08-13..08-15 (verified in `markets`: 5m
 * lookback=30 went 2304 -> 2271 -> 7 -> 0 while lookback=60 went 0 -> 33 ->
 * 2297 -> 2304), so on 08-15 nothing settled on the 30s stream and the expected
 * set was legitimately empty. The old code fed that empty set straight into
 * assessTickCoverage, whose empty-set fail-closed exists to catch a MISSING
 * config — so a normal upstream migration read as a config fault and reddened a
 * day whose data was complete (twap30s: 8 symbols / 603,395 rows, F 2391/2391).
 *
 * The three verdicts are deliberately distinct because they fail in opposite
 * directions:
 *   assert  — markets settled on this stream: full completeness assertions.
 *   retired — twap markets exist today but none use THIS lookback: the stream
 *             is still collected and still shipped, so it stays visible as a
 *             disclosure, but it must not be graded against a market set that
 *             does not exist.
 *   none    — the day has NO twap-rule market at all. Never a quiet skip: since
 *             2026-08-07 every updown market settles on TWAP, so an empty map
 *             means gamma discovery stopped writing cryptoMarketConfig or
 *             upstream changed the settlement source again. Both need a human.
 *   invalid — the key IS present but not a Set: expectedTwapSymbolsBySource has
 *             drifted. Kept distinct from retired on purpose (Codex 2026-08-16):
 *             an absent key is a legitimate upstream migration, a malformed one
 *             is our own bug, and folding the second into the first would let a
 *             refactor silently downgrade every topic to a disclosure.
 *
 * @param twapExpected result of expectedTwapSymbolsBySource
 * @param source       topic source key (see TWAP_TOPICS)
 * @returns {{kind:'assert', expected:Set<string>}|{kind:'retired'}|{kind:'none'}|{kind:'invalid'}}
 */
export function twapTopicPlan(twapExpected, source) {
  const map = (twapExpected && typeof twapExpected === 'object') ? twapExpected : {};
  const expected = map[source];
  // Shape is judged BEFORE liveness (Codex 2026-08-16 round-2): if every entry
  // were malformed, a liveness-first order would find no live Set and report
  // `none` — blaming gamma discovery or upstream for what is our own shape
  // regression, and sending the operator down the wrong diagnosis.
  if (expected !== undefined && !(expected instanceof Set)) return { kind: 'invalid' };
  // Only non-empty sets count as "a topic someone settles on": an empty Set
  // parked under a key must not out-vote the none verdict.
  const live = Object.values(map).some((s) => s instanceof Set && s.size > 0);
  if (!live) return { kind: 'none' };
  if (expected === undefined || expected.size === 0) return { kind: 'retired' }; // upstream migrated away
  return { kind: 'assert', expected };
}

/**
 * Classify one TWAP market's settlement recompute. All inputs primitive:
 * @param officialUp        official outcome (true = Up)
 * @param startFav/endFav   TWAP stream full_accuracy_value (1e18 fixed-point
 *                          decimal string) at the exact boundary seconds, or
 *                          null when that boundary second is missing
 * @param hasStreamInWindow whether the TWAP stream has ANY rows inside
 *                          [start_sec - lookback, end_sec] — discriminates a
 *                          boundary feed gap (indeterminate) from "stream not
 *                          collected yet" (approx path). Window-scoped on
 *                          purpose: a mid-day deploy day must classify its
 *                          pre-deploy markets as approx, not drown the audit
 *                          in indeterminates.
 * @param approxStart/approxEnd  mean of instantaneous ticks over the lookback
 *                          window at each boundary (number|string|null)
 * @returns {{mode:'exact'|'approx', verdict:'agree'|'disagree'|'indeterminate'|'noTick'|'invalid', relGap?:number}}
 */
export function classifyTwapSettlement({ officialUp, startFav, endFav, hasStreamInWindow, approxStart, approxEnd, eps = APPROX_REL_EPS }) {
  if (typeof officialUp !== 'boolean') return { mode: 'exact', verdict: 'invalid' };
  if (startFav != null && endFav != null) {
    let calcUp;
    try { calcUp = BigInt(endFav) >= BigInt(startFav); } catch { return { mode: 'exact', verdict: 'invalid' }; }
    return { mode: 'exact', verdict: calcUp === officialUp ? 'agree' : 'disagree' };
  }
  if (hasStreamInWindow) return { mode: 'exact', verdict: 'indeterminate' }; // boundary feed gap
  const s = approxStart == null ? NaN : Number(approxStart);
  const e = approxEnd == null ? NaN : Number(approxEnd);
  if (Number.isNaN(s) && Number.isNaN(e)) return { mode: 'approx', verdict: 'noTick' };
  if (Number.isNaN(s) || Number.isNaN(e)) return { mode: 'approx', verdict: 'noTick' };
  // a non-positive average of archived prices is corruption, not a data gap —
  // it must not hide behind the noTick disclosure
  if (!(s > 0) || !(e > 0) || !Number.isFinite(s) || !Number.isFinite(e)) return { mode: 'approx', verdict: 'invalid' };
  const calcUp = e >= s;
  if (calcUp === officialUp) return { mode: 'approx', verdict: 'agree' };
  const relGap = Math.abs(e - s) / s;
  return relGap < eps
    ? { mode: 'approx', verdict: 'indeterminate', relGap } // near-tie inside approximation error
    : { mode: 'approx', verdict: 'disagree', relGap };
}

// ---------------------------------------------------------------------------
// Attribution for check-F disagreements: ours, or the upstream resolver's?
//
// 2026-08-17 was the first day since the TWAP switch where F recomputed a
// different side than the official outcome (4 of 2155; every prior day was
// 100%). The evidence said the fault was upstream, not in our archive:
//   * the official resolution source for all four IS the stream we compared
//     (raw.resolutionSource -> data.chain.link/streams/<asset>-usd-twap-60s),
//     and our stream labelling is not swapped (live relay frames carry
//     window_s: _thirty says 30, _sixty says 60);
//   * our 60s stream is right where it matters: over the 103 markets that day
//     whose two TWAP streams implied OPPOSITE sides, the 60s stream matched the
//     official outcome 99/103 — the four exceptions ARE these disagreements, so
//     "the 30s stream matched all four" was pure selection bias;
//   * our own last_trade_price tape (independent code path, verbatim) shows the
//     market trading 0.99+ on the side WE compute in all four, i.e. traders
//     watching the same Chainlink feed also disagreed with the official label;
//   * every disagreement sat in the late-resolved tail. Cross-tabulating the
//     day's markets by gamma resolution latency against agreement:
//         <=5m 2027/0, 5-10m 16/0, 10-20m 56/0, 20-30m 1/0,
//         30-60m 44/3, >60m 7/1        (agree/disagree)
//     2100+ markets resolved on time disagreed zero times; all four sat in the
//     ~55-market >30min tail, clustered at closedTime ~13:15 UTC — an upstream
//     resolver that fell behind and caught up in a delayed batch.
//
// So a disagreement on a market the upstream resolver settled LATE is
// disclosed, not red: there is no operator action (we ship the official label
// verbatim, which is what actually paid out, alongside the feed that
// contradicts it). Everything else stays red.
//
// WHY LATENCY IS A SAFE PREDICATE. Resolution latency is a property of the
// upstream resolver, causally unrelated to our tick pipeline, so an our-side
// fault cannot hide behind it except by coincidence — and an our-side fault is
// systematic, so it would also hit the ~2100 on-time markets and stay red. The
// cap is the backstop for the case that reasoning is wrong: more than a handful
// of late-resolve anomalies in one day is a structural event, and the whole set
// reverts to red for a human. Same shape as check E's SUSPECT_CAP.
export const CHAINLINK_STREAMS_HOST = 'data.chain.link';
export const LATE_RESOLVE_MIN_DEFAULT = 30;   // minutes; normal auto-resolution is < 5
export const LATE_RESOLVE_CAP_DEFAULT = 10;   // more than this in a day => structural, red

/**
 * Does the market's OFFICIAL resolution source name exactly the stream our
 * recompute compared?
 *
 * This is the eligibility gate for the late-resolve disclosure (Codex
 * 2026-08-18, high). Latency alone is far too broad a predicate: it would also
 * excuse a disagreement produced by OUR OWN metadata faults — a dropped or
 * drifted raw.cryptoMarketConfig, a lookback that routed us to the wrong
 * stream, or an instant-rule day recomputed against the wrong boundary — as
 * long as upstream happened to resolve that market late and fewer than CAP of
 * them landed in one day. The 2026-08-17 evidence only covers markets where
 * the official source and the stream we used are provably THE SAME feed; only
 * those may be disclosed, everything else stays red.
 *
 * gamma spells it as a Chainlink stream URL, e.g.
 *   https://data.chain.link/streams/sol-usd-twap-60s-streams
 * The check is a STRICT ANCHORED MATCH on the raw string. Two weaker designs
 * were tried and rejected, both caught in review:
 *   - a substring regex (Codex round-2, high): any text merely CONTAINING the
 *     fragment passed, so https://example.com/streams/sol-usd-twap-60s-streams
 *     was accepted;
 *   - new URL() + hostname/pathname comparison (Codex round-3, medium): the
 *     URL parser NORMALISES dot segments before you can inspect them, so
 *     .../doge-usd-twap-30s-streams/../sol-usd-twap-60s-streams (and its %2e
 *     encoding) collapsed onto the expected path and passed, as did userinfo
 *     forms like https://evil.tld@data.chain.link/...
 * Anchoring on the raw string admits no normalisation step at all: userinfo, a
 * port, dot segments, percent-encoding and off-host URLs simply fail to match.
 * Anything absent, malformed, off-host, or naming a different asset/lookback
 * returns false — the caller then keeps the disagreement red.
 *
 * @param resolutionSource raw.resolutionSource
 * @param asset            markets.asset (e.g. "sol")
 * @param rule             result of settlementRule() for this market
 */
export function resolutionSourceMatchesRule(resolutionSource, asset, rule) {
  if (rule == null || rule.kind !== 'twap') return false;
  if (typeof resolutionSource !== 'string' || typeof asset !== 'string' || asset === '') return false;
  // asset is whitelisted first so it can never contribute regex metacharacters
  if (!/^[a-z0-9]+$/i.test(asset)) return false;
  if (!Number.isInteger(rule.lookbackSec) || rule.lookbackSec <= 0) return false;
  const host = CHAINLINK_STREAMS_HOST.replace(/\./g, '\\.');
  const pattern = new RegExp(
    `^https://${host}/streams/${asset.toLowerCase()}-usd-twap-${rule.lookbackSec}s-streams/?(?:[?#].*)?$`,
    'i',
  );
  return pattern.test(resolutionSource.trim());
}

/**
 * Parse gamma's closedTime ("2026-08-17 13:15:00+00") to epoch ms.
 * The offset is normalised with a regex rather than a bare replace('+00','Z'),
 * which would corrupt the other legal spellings (+00:00 -> Z:00, +0000 -> Z00)
 * and silently turn the whole column unparsable.
 * @returns {number|null} epoch ms, or null when absent/unparsable
 */
export function parseGammaClosedTime(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const trimmed = s.trim();
  // An explicit timezone is MANDATORY (Codex 2026-08-18, medium). Date.parse on
  // a bare "2026-08-17 13:15:00" resolves in the LOCAL zone, so the same
  // historical day re-audited on the UTC server and on the UTC+8 dev box would
  // produce lags 8 hours apart — and a gamma format drift would silently keep
  // clearing the late threshold instead of turning the day red.
  if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(trimmed)) return null;
  let iso = trimmed.replace(' ', 'T');
  const m = /([+-])(\d{2}):?(\d{2})?$/.exec(iso);
  if (m) iso = `${iso.slice(0, m.index)}${m[1]}${m[2]}:${m[3] ?? '00'}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Minutes between a market's end boundary and the moment upstream resolved it.
 * @returns {number|null} null when either side is missing/unparsable
 */
export function resolutionLagMinutes(closedTime, endSec) {
  const closed = parseGammaClosedTime(closedTime);
  if (closed == null) return null;
  // Strict typing, never Number() coercion: pg hands BIGINT back as a string,
  // but Number(null)/Number('')/Number(true) are all finite, so a coercing
  // guard would read a MISSING end_sec as epoch 0 and compute a ~56-year lag —
  // i.e. every row with no boundary would be excused as "resolved late". A
  // unit test caught exactly that.
  const end = typeof endSec === 'number' ? endSec
    : (typeof endSec === 'string' && /^\d+$/.test(endSec.trim())) ? Number(endSec.trim())
      : NaN;
  if (!Number.isFinite(end) || end <= 0) return null;
  return (closed - end * 1000) / 60_000;
}

/**
 * Split check-F disagreements into the ones we must go red on and the ones
 * attributable to a late upstream resolution (disclosed).
 *
 * Fail-closed everywhere: an unparsable closedTime, a missing end_sec, a
 * negative lag, or a non-finite threshold/cap all keep a disagreement RED. A
 * NaN threshold must never wave findings through — `NaN >= x` is false here by
 * construction, but the explicit guard is deliberate: this repo has been bitten
 * three times by env typos silently turning a check permanently green.
 *
 * Only items explicitly marked `lateEligible` may be disclosed — see
 * resolutionSourceMatchesRule for why latency alone is not a sufficient
 * predicate. An item without the flag is red regardless of how late it was.
 *
 * @param items [{slug, closedTime, endSec, lateEligible}]
 * @param opts  {lateMinutes, cap}
 * @returns {{red:string[], disclosed:Array<{slug:string,lagMin:number}>, capExceeded:boolean, invalidConfig:boolean}}
 */
export function attributeDisagreements(items, { lateMinutes, cap } = {}) {
  const list = Array.isArray(items) ? items : [];
  const allRed = (invalidConfig) => ({ red: list.map((i) => i?.slug), disclosed: [], capExceeded: false, invalidConfig });
  if (!Number.isFinite(lateMinutes) || lateMinutes <= 0) return allRed(true);
  if (!Number.isFinite(cap) || cap < 0) return allRed(true);
  const red = [];
  const disclosed = [];
  for (const it of list) {
    if (it?.lateEligible !== true) { red.push(it?.slug); continue; } // strict true, never truthy
    const lag = resolutionLagMinutes(it?.closedTime, it?.endSec);
    if (lag == null || lag < 0 || lag < lateMinutes) { red.push(it?.slug); continue; }
    disclosed.push({ slug: it?.slug, lagMin: lag });
  }
  // more than a handful in one day is a structural event, not a stray upstream
  // catch-up batch: hand the whole set back to a human
  if (disclosed.length > cap) return { ...allRed(false), capExceeded: true };
  return { red, disclosed, capExceeded: false, invalidConfig: false };
}
