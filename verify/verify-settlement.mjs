#!/usr/bin/env node
// Reproduce outcometick's public settlement audit from the free sample data.
//
//   node verify/verify-settlement.mjs [--data ./polymarket-data-samples] [--official 50] [--offline]
//
// It settles every market in the unpacked sample again, with the same code the
// audit runs (settlement-verdicts.mjs + audit-settlement.mjs, copied verbatim
// next to this file), then fetches the verdicts outcometick.com publishes for
// that day and compares them market by market. Exit code 0 = identical.
//
// --official N (Polymarket only) also asks Polymarket's own API for N markets'
// outcomes and compares them with the outcomes in the sample's markets file —
// a check that does not go through outcometick at all.
//
// Only markets the sample can settle on its own are compared: a market that
// opened the day before needs the previous day's stream, and a Predict.fun
// market whose price file is not in the sample has nothing to settle from.
// The report says how many were compared and why the rest were left out.
//
// Node 18+, no dependencies. In the outcometick archive this file lives in
// chainlink-data scripts/lib/ beside the audit code; the sample repositories
// carry an exact copy (scripts/sync-sample-verifier.mjs).

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import {
  auditDay, auditPredictDay, parseJsonl, MARKETS_RE, PREDICT_MARKETS_RE, officialOutcome,
} from './settlement-verdicts.mjs';

export const AUDIT_API = 'https://outcometick.com/v1/public/settlement-audit';
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';

/** Every file under `root` as a catalog entry whose path is relative to it ("data/..."). */
export async function localCatalog(root) {
  const files = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push({ path: path.relative(root, full).split(path.sep).join('/'), sha256: '' });
    }
  }
  await walk(root);
  return { files: files.filter((f) => f.path.startsWith('data/')) };
}

/** The venue and the single UTC day a sample holds. */
export function sampleShape(catalog) {
  const pm = catalog.files.filter((f) => MARKETS_RE.test(f.path));
  const pf = catalog.files.filter((f) => PREDICT_MARKETS_RE.test(f.path));
  const venue = pm.length ? 'polymarket' : pf.length ? 'predict' : null;
  if (!venue) throw new Error('no markets file found — point --data at the unpacked sample directory');
  const days = new Set((venue === 'polymarket' ? pm : pf).map((f) => /(\d{4}-\d{2}-\d{2})\.jsonl\.gz$/.exec(f.path)[1]));
  if (days.size !== 1) throw new Error(`expected one sample day, found ${[...days].join(', ')}`);
  return { venue, day: [...days][0] };
}

const keyOf = (venue, v) => String(venue === 'predict' ? v.marketId : v.slug);

/**
 * Compare locally recomputed verdicts with the published ones, field by field.
 * Only `local` markets are compared (the sample is a subset of the day).
 */
export function compareVerdicts(venue, local, published) {
  const byKey = new Map(published.map((v) => [keyOf(venue, v), v]));
  const fields = ['verdict', 'official', 'ours', 'reason', 'mode'];
  const same = [];
  const different = [];
  const unpublished = [];
  for (const v of local) {
    const p = byKey.get(keyOf(venue, v));
    if (!p) { unpublished.push(keyOf(venue, v)); continue; }
    const diff = fields.filter((f) => (v[f] ?? null) !== (p[f] ?? null));
    if (diff.length) different.push({ key: keyOf(venue, v), fields: diff.map((f) => `${f}: ${v[f] ?? null} vs ${p[f] ?? null}`) });
    else same.push(keyOf(venue, v));
  }
  return { same, different, unpublished };
}

async function readEntry(root, entry) {
  return gunzipSync(await readFile(path.join(root, entry.path))).toString('utf8');
}

/** Markets the sample can settle without the previous day or a missing price file, with the reason the rest were left out. */
async function settleableLocally(root, catalog, venue, day, verdicts) {
  const d0 = Date.parse(`${day}T00:00:00Z`) / 1000;
  const left = { openedDayBefore: 0, priceFileNotInSample: 0 };
  let feeds = null;
  let feedOf = null;
  if (venue === 'predict') {
    feeds = new Set(catalog.files.map((f) => /-feed(\d+)-predict-prices-/.exec(f.path)?.[1]).filter(Boolean));
    feedOf = new Map();
    for (const f of catalog.files.filter((x) => PREDICT_MARKETS_RE.test(x.path))) {
      for (const m of parseJsonl(await readEntry(root, f), f.path)) feedOf.set(String(m.market_id), String(m.price_feed_id));
    }
  }
  const kept = verdicts.filter((v) => {
    if (v.start < d0) { left.openedDayBefore++; return false; }
    if (venue === 'predict' && v.reason !== 'feed_not_archived' && !feeds.has(feedOf.get(String(v.marketId)))) { left.priceFileNotInSample++; return false; }
    return true;
  });
  return { kept, left };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'outcometick-verify-settlement' }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Polymarket's own outcome for a market, as its public API reports it; null when it cannot say.
 * A closed market is only listed with closed=true. An empty answer is "could not read" (the API
 * also answers [] when it rate-limits), never a different outcome.
 */
async function gammaOutcome(slug) {
  const rows = await getJson(`${GAMMA_API}?slug=${encodeURIComponent(slug)}&closed=true`);
  const m = Array.isArray(rows) ? rows[0] : null;
  if (!m) return null;
  let prices = m.outcomePrices;
  if (typeof prices === 'string') { try { prices = JSON.parse(prices); } catch { return null; } }
  return officialOutcome({ resolved: true, outcome_prices: prices });
}

async function main(argv) {
  const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i === -1 ? dflt : argv[i + 1]; };
  const root = path.resolve(arg('data') ?? (existsSync('polymarket-data-samples') ? 'polymarket-data-samples' : 'predict-fun-data-samples'));
  const officialN = Number(arg('official', '0'));
  const catalog = await localCatalog(root);
  const { venue, day } = sampleShape(catalog);
  const audit = venue === 'polymarket' ? auditDay : auditPredictDay;
  const { verdicts } = await audit({ day, catalog, read: (_c, e) => readEntry(root, e), skipAssets: new Set(['ZEC']) });
  const { kept, left } = await settleableLocally(root, catalog, venue, day, verdicts);
  console.log(`${venue} sample ${day}: recomputed ${verdicts.length} markets; ${kept.length} can be settled from the sample alone`
    + ` (left out: ${left.openedDayBefore} opened the day before${venue === 'predict' ? `, ${left.priceFileNotInSample} have no price file in the sample` : ''}).`);
  // Nothing to compare is not a success: a truncated or empty sample must not "reproduce" anything.
  if (kept.length === 0) { console.log('CANNOT VERIFY — the sample holds no market it can settle on its own.'); return 2; }
  const tally = (k) => kept.filter((v) => v.verdict === k).length;
  console.log(`Locally: ${tally('match')} agree, ${tally('mismatch')} disagree, ${tally('insufficient')} cannot be settled.`);
  let ok = true;
  let compared = false;
  if (!argv.includes('--offline')) {
    const url = `${AUDIT_API}/${day}${venue === 'polymarket' ? '' : `?venue=${venue}`}`;
    const published = (await getJson(url)).markets;
    const r = compareVerdicts(venue, kept, published);
    console.log(`Published audit (${url}): ${published.length} markets that day. Compared ${kept.length}: ${r.same.length} identical, ${r.different.length} different, ${r.unpublished.length} not in the published file.`);
    for (const d of r.different.slice(0, 10)) console.log(`  differs ${d.key}: ${d.fields.join('; ')}`);
    for (const k of r.unpublished.slice(0, 10)) console.log(`  not published: ${k}`);
    ok = r.different.length === 0 && r.unpublished.length === 0;
    compared = r.same.length > 0;
  }
  if (officialN > 0) {
    if (venue !== 'polymarket') {
      console.log('--official: Predict.fun has no public outcome API to check against; the outcome is the one its published start and end prices imply.');
    } else {
      const pool = kept.filter((v) => v.official);
      const pick = pool.sort(() => Math.random() - 0.5).slice(0, officialN);
      if (pick.length === 0) { console.log('--official: no market with an official outcome to check.'); ok = false; }
      let agree = 0;
      let unread = 0;
      const off = [];
      for (const v of pick) {
        let g = null;
        try { g = await gammaOutcome(v.slug); } catch { g = null; }
        if (g === null) unread++;
        else if (g === v.official) agree++;
        else off.push(`${v.slug}: sample ${v.official} vs Polymarket ${g}`);
        await new Promise((res) => setTimeout(res, 600)); // be gentle with a public API
      }
      console.log(`Polymarket's own API (${GAMMA_API}): ${agree} of ${pick.length - unread} markets it answered for have the outcome the sample's markets file records`
        + `${unread ? `; ${unread} could not be read (closed market not listed, or rate-limited — try fewer)` : ''}.`);
      for (const o of off.slice(0, 10)) console.log(`  ${o}`);
      if (pick.length > 0 && unread === pick.length) console.log('--official: the API answered for none of them; nothing was checked.');
      ok = ok && off.length === 0 && unread < pick.length;
    }
  }
  if (!ok) { console.log('MISMATCH — see above.'); return 1; }
  if (!compared) { console.log('Recomputed locally only — not compared with the published audit (drop --offline to compare).'); return 0; }
  console.log('OK — reproduced: every compared market matches the published audit.');
  return 0;
}

// Run only when executed directly (the tests import the functions above).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('verify-settlement.mjs')) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(2); });
}
