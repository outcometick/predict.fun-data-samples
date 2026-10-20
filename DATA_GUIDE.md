# Data Guide

(中文版见 数据使用说明.md)

## Layout

The sample bundle unpacks to a directory laid out exactly like the paid
archive, so anything written against a sample keeps working against a delivered
dataset unchanged:

```
predict-fun-data-samples/
  data/predict-fun/prices/BTCUSDT/BTCUSDT-feed<id>-predict-prices-<date>.csv.gz
  data/predict-fun/orderbook/BTC-5M/BTC-5M-predict-orderbook-<date>.jsonl.gz
  data/predict-fun/markets/predict-markets-<date>.jsonl.gz
  data/predict-fun/klines/BTCUSDT/1m/BTCUSDT-feed<id>-1m-<date>.csv.gz
```

The directory segments carry meaning, and tooling reads them:
`data/predict-fun/<dataset>/<series>/`, where the series key is the symbol for
prices and klines (`BTCUSDT`) and `<ASSET>-<INTERVAL>` for the order book
(`BTC-5M`, `ETH-15M`, `BNB-DAILY`). The markets table is one file per day
covering every asset and interval, so it has no series directory. A full
purchased dataset has the same shape with more assets, more intervals, all 13
kline periods and more days under it.

Predict.fun is the prediction-market venue reachable from the Binance Wallet
front end (a BNB-chain venue). This dataset is collected independently from our
Polymarket dataset and is **never mixed with it** — different venue, different
settlement source, separate files.

## <SYMBOL>-feed<id>-predict-prices-<date>.csv.gz — settlement price ticks

| column | meaning |
|---|---|
| price_feed_id | upstream feed id (1 = BTCUSDT, 2 = ETHUSDT, 3 = BNBUSDT) |
| symbol | feed symbol, e.g. BTCUSDT |
| provider | the channel we subscribe this feed on — see the note below (ignore this column for data dated 2026-09-03 and earlier) |
| publish_time | price event time (unix **seconds**) |
| server_ts | upstream message timestamp (unix **seconds**) |
| price | price as float64 |
| recv_ms | collector receive time (unix **milliseconds**) |

Note on `provider`: this column records **the channel we subscribe the feed on**
(`CHAINLINK`, or `PYTH` for feeds that publish on the pyth topic). It is a
property of the feed, not of the price, and it is not an upstream per-tick source
attribution.

**For data dated 2026-09-03 and earlier this column is unreliable and should be
ignored.** It carried the settlement source declared by whichever market our
discovery loop had processed most recently — and a single price feed is shared by
markets of several lengths whose declarations differ (5m/15m declare `CHAINLINK`,
hourly and 24h declare `BINANCE`), so the label flipped back and forth on our
10-second poll. It says nothing about where a given price came from. Fixed at the source on 2026-09-05; data dated 2026-09-04 onward carries the
corrected label.

**The price data itself was never affected.** Every tick we archive arrives on a
single upstream topic (`chainlinkAssetPriceUpdate/<feed_id>`), and the feed
carries no per-tick source information of any kind — so there is no mixed-source
structure in this data to correct for, no impact on volatility or any other
statistic, and no reason to filter or group by this column. If you have split
your data on it, merge it back. Independently verified: on the 2026-10-18 sample
day, all 559 settlement-boundary-second ticks we hold reproduce the venue's own
published `start_price`/`end_price` exactly.

Limitation: our tick primary key is `(price_feed_id, publish_time, price)` and
does not include `provider`, so a duplicate frame is absorbed and only the first
label survives.

Note on precision: unlike our Polymarket settlement feed, Predict.fun publishes
this price as a float64 only — there is no full-precision integer string
upstream, so none is archived. Ticks are keyed by
`(price_feed_id, publish_time, price)`, which absorbs the duplicate frames the
upstream WebSocket sends for each publish time.

## <ASSET>-<INTERVAL>-predict-orderbook-<date>.jsonl.gz — order-book snapshots

Series key is `<ASSET>-<INTERVAL>`, e.g. `BTC-5M`, `ETH-15M`, `BNB-DAILY`.

| field | meaning |
|---|---|
| market_id | upstream market id |
| category_slug | market slug; suffix = slot start (unix sec) |
| update_ts_ms | upstream book update time (ms) |
| recv_ms | collector receive time (ms) |
| payload | the upstream snapshot object, stored verbatim |

`payload` contains `bids` / `asks` as `[price, size]` pairs, plus the upstream's
own `version`, `marketId`, `orderCount`, `lastOrderSettled` and
`settlementsPending` fields exactly as received.

Note: these are **full snapshots only**. Predict.fun's stream does not publish
order-book deltas, so unlike our Polymarket dataset there is no `price_change`
series and no trade tape. Book state at time t = the market's latest snapshot
with `recv_ms <= t`.

Throttling (disclosed), which changed and matters if you span the date:

- through 2026-08-24: kept at most 1 snapshot per market per second
- **from 2026-08-25: no throttling at all — every snapshot the upstream pushed
  is archived**

The earlier throttle dropped a large majority of upstream snapshots, so a day
from 2026-08-25 onward carries several times the book detail of an earlier
one. Compare for yourself: the sample day holds 519,724 snapshots for BTC-5M
where 2026-07-24 held 68,398.

## predict-markets-<date>.jsonl.gz — market metadata and settlement outcome

One file per day covering every asset and interval.

| field | meaning |
|---|---|
| category_slug | market id; suffix = slot start (unix sec) |
| asset | btc / eth / bnb |
| interval_label | `5m` / `15m` / `hourly` / `daily` — see the note below |
| market_id | upstream market id (joins to the order-book files) |
| price_feed_id / price_feed_symbol | which feed settles this market |
| price_feed_provider | settlement source for this market: `CHAINLINK` for 5m and 15m, `BINANCE` for daily |
| condition_id | on-chain condition id |
| start_sec / end_sec | slot boundaries (unix sec) |
| start_price | the strike — Up must close strictly above it |
| end_price | the settlement price |
| status | the market state as of our **last read** of it upstream — not a settlement flag, see below |

Interval labels: files exported **before 2026-09-05** label the 1-hour markets
as `daily`. That was our own slug-parsing bug — a single `up-or-down` pattern
matched both families — and it is corrected from that date on. The 24h market is
the one whose slug contains `-on-` (`bitcoin-up-or-down-on-september-5-2026`);
the 1-hour one ends in the hour (`bitcoin-up-or-down-september-5-2026-5am-et`).
If you need the true interval on older files, `end_sec - start_sec` is always
authoritative.

Settlement rule, three outcomes: `end_price > start_price` → Up wins;
`end_price < start_price` → Down wins; `end_price == start_price` → the slot is
a **push**, where the venue resolves both sides as won and stakes are returned.
A tie is not an Up win here — the opposite of Polymarket — and about 1 in 100
five-minute slots closes flat, so a binary `>=` predicate will misscore them.
Both values come from the upstream market object, so a market's outcome is
verifiable from this file alone; the price files let you audit the path in
between.

Do **not** use `status` to decide whether a slot has settled. We stop re-reading
a market once it has an `end_price`, and at that moment the venue very often
still reports it as `OPEN` — so `status` freezes at whatever it was then. Most 5m/15m slots do read `RESOLVED` (about 92%),
but the Binance-settled families almost never do — **0 of 255 settled 24h
markets and 0.65% of settled hourly ones** — so filtering on
`status == 'RESOLVED'` silently drops nearly all of them. The reliable test is whether `end_price` is
present; in our whole history no row carries `RESOLVED` without one.

## <SYMBOL>-feed<id>-<period>-<date>.csv.gz — klines

| column | meaning |
|---|---|
| ts_ms | bucket open time (ms) |
| open / high / low / close | float64 prices within the bucket |
| ticks | number of ticks aggregated into the bucket |

Periods 1s..1d are per-day files; 3d / 1w / 1mo ship as full-history snapshots
named `-thru-<date>` and contain completed buckets only. Klines are derived
from the price ticks above — you can always recompute them yourself.

## samples/manifest.json — per-file row counts and sha256 checksums for this sample

Every sample file here is byte-identical to the corresponding file in the paid
dataset; the sha256 values match the archive's own checksum index.
