# Predict.fun Crypto Up/Down — Market Data

Tick-level market data for **Predict.fun** crypto Up/Down markets — the
prediction-market venue reachable from the Binance Wallet front end (BNB
chain) — collected 24/7 directly from the source feeds. This repository hosts
**free samples and documentation**; the full dataset is sold by subscription or
by range.

本仓库提供 **Predict.fun**（币安钱包前端接入的预测市场，BNB 链）加密 Up/Down
市场数据的**免费样例与文档**；完整数据集按订阅或按区间出售。

> This is a **separate venue** from Polymarket, with a different settlement
> source. It is collected and sold independently and is never mixed into our
> Polymarket dataset. For that one, see
> [`polymarket-data-samples`](https://github.com/outcometick/polymarket-tick-data-samples).
>
> 本数据集与 Polymarket 是**不同场子、不同结算源**，独立采集、独立出售，绝不与
> Polymarket 数据混装。

## What the full dataset contains / 完整数据集内容

| dataset | description |
|---|---|
| `prices` | The settlement price feed, tick-by-tick (~1Hz per symbol), with three timestamps and a `provider` column recording the channel we subscribe the feed on (see *Known limits*) |
| `orderbook` | Full order-book snapshots. Throttled to 1/sec per market through 2026-08-24; **unthrottled from 2026-08-25**, so every snapshot the venue pushed is archived — several times the detail |
| `markets` | Per-market metadata with **strike** (`start_price`) and **settlement price** (`end_price`) — every slot's outcome (Up / Down / push) is verifiable from this file alone |
| `klines` | 13 intraday periods (1s..1d) plus 3d / 1w / 1mo full-history snapshots, derived from the price ticks |

- Assets: BTC, ETH, BNB × intervals 5m / 15m / hourly / daily. The 5m and 15m
  markets settle on **Chainlink**; the hourly and 24h ones settle on **Binance**
  candles — `price_feed_provider` says which, per market
- History from 2026-06-12, growing daily. Note that **2026-06-12 is a partial
  day** (collection started mid-day; ~66% of the day's seconds) — the **first
  complete UTC day is 2026-06-13**. Early days also carry fewer ETH/BNB slots,
  which only had daily markets at the time.
- Every file comes with its size and SHA-256, so you can verify what you
  received; the price files carry per-tick timestamps, so feed continuity is
  auditable directly from the data
- What the venue's feeds contain and how they are captured:
  [Predict.fun market data](https://outcometick.com/predict-fun-data) /
  [Predict.fun 历史数据说明](https://outcometick.com/zh/predict-fun-data)

## Samples / 样例

**[Download the sample bundle](https://github.com/outcometick/predict.fun-data-samples/releases/latest/download/predict-fun-data-samples.tar.gz)**
— one real, unmodified UTC day (**2026-10-18**) of the BTC 5-minute series plus
the settlement price feed, the full market/settlement table and one kline period.

The same sample day, together with the Polymarket one, is also on
[Kaggle](https://www.kaggle.com/datasets/ligengxin96/polymarket-predict-fun-tick-data)
(unpacked) and
[Hugging Face](https://huggingface.co/datasets/Ligengxin96/polymarket-predict-fun-tick-data)
(original `.gz` files), under CC BY 4.0.

同一个样例日（连同 Polymarket 那份）也发布在
[Kaggle](https://www.kaggle.com/datasets/ligengxin96/polymarket-predict-fun-tick-data)（解压版）
与 [Hugging Face](https://huggingface.co/datasets/Ligengxin96/polymarket-predict-fun-tick-data)
（原样 `.gz`），协议 CC BY 4.0。

> **The data is in the Release, not in the git tree.** Clicking *Code → Download
> ZIP* gets you the documentation and nothing else. This is deliberate: a
> half-populated archive would replay without errors and give wrong answers, so
> the repository ships either the whole day or none of it.
>
> **数据在 Release 里，不在 git 仓库里。** 点 *Code → Download ZIP* 只会拿到文档。
> 这是有意的：残缺的归档跑起来不报错却会给出错误结果，所以要么给完整一天，要么不给。

```bash
curl -L https://github.com/outcometick/predict.fun-data-samples/releases/latest/download/predict-fun-data-samples.tar.gz | tar xz
```

It unpacks to `predict-fun-data-samples/`, laid out exactly like the paid
archive, so it replays directly:

```bash
# The order book is unthrottled from 2026-08-25 — 519,724 full snapshots in this
# one day — so give the replay room. The default Node heap is not enough.
NODE_OPTIONS=--max-old-space-size=8192 ot run . --data ./predict-fun-data-samples
```

| file (inside the bundle) | rows | what |
|---|---|---|
| `data/predict-fun/prices/BTCUSDT/BTCUSDT-feed1-predict-prices-2026-10-18.csv.gz` | 85,339 | settlement price ticks |
| `data/predict-fun/orderbook/BTC-5M/BTC-5M-predict-orderbook-2026-10-18.jsonl.gz` | 519,724 | order-book snapshots, unthrottled |
| `data/predict-fun/markets/predict-markets-2026-10-18.jsonl.gz` | 1,245 | every market that day (all assets and intervals) with strike + settlement price |
| `data/predict-fun/klines/BTCUSDT/1m/BTCUSDT-feed1-1m-2026-10-18.csv.gz` | 1,440 | 1-minute klines (one of 13 periods in the full set) |

The order book has been unthrottled since 2026-08-25: this day carries 519,724
snapshots for BTC-5M, against 68,398 on a throttled day. The whole day was
collected after the `provider` fix went live (2026-09-05), so that column is
correct as captured, not corrected after the fact.

盘口自 2026-08-25 起不再限流：本样例日仅 BTC-5M 就有 519,724 条快照，而限流时期的
日子只有 68,398 条。整个样例日都是在 `provider` 修复上线（2026-09-05）之后采集的，
因此这一列是采集时就正确的，不是事后修正的。

Each file is also attached to the Release individually, for anyone who only
wants one of them. Row counts are data rows (CSV headers excluded); every file
carries its SHA-256 in [`samples/manifest.json`](samples/manifest.json). Those
checksums are the archive's own, so a sample verifies byte for byte against a
delivered bundle.

Field-level documentation: [`DATA_GUIDE.md`](DATA_GUIDE.md) (English) /
[`数据使用说明.md`](数据使用说明.md) (中文). The same column definitions online:
[dataset schema reference](https://outcometick.com/docs/schemas) / [字段规格](https://outcometick.com/zh/docs/schemas).

### Verify it yourself / 自行验证

The venue publishes each market's own `start_price` (the strike) and
`end_price` (the settlement price). What matters about our data is whether the
price stream we sell is the one those numbers came from — so that is what this
check asks: **does our archived tick at those exact seconds reproduce the
venue's published prices?**

On 2026-10-18, across the 291 BTC 5-minute markets in the sample:

| | count | result |
|---|---|---|
| boundary seconds we hold a tick for | 559 | **559 of 559 reproduce the venue's published price** |
| boundary seconds absent from our feed | 23 | not independently provable — reported as undetermined |

Prices are compared at the precision the venue itself printed. Our files carry
the full float64 expansion (`64944.024999999994`), the venue prints the same
number as `64944.025`; those are one value, not a disagreement.

Settlement is then plain arithmetic on the same file, with one wrinkle worth
knowing before you score anything: a slot that closes exactly where it opened is
**a push, not an Up win** — the venue resolves both sides as won and returns the
stakes. So `end_price > start_price` → Up, `end_price < start_price` → Down,
`end_price == start_price` → push. That day: **139 Up, 152 Down and no push**.
Pushes do happen: on 2026-08-25, `btc-updown-5m-1787649300` opened and closed at
`79844.005` and was resolved as one.

Ties are not a rounding curiosity: across our history roughly **1 in 100
five-minute slots** closes flat. Note this is the opposite of Polymarket, whose
rules settle a tie to Up — a binary `>=` predicate is wrong on this venue.
Both venues' settlement rules, side by side, are in the
[settlement documentation](https://outcometick.com/docs/settlement).

场方为每个市场发布自己的 `start_price`（strike）与 `end_price`（结算价）。对我们的
数据而言真正要紧的是：**我们卖的这条价格流，是不是它结算时用的那条**。所以这里核对的
是「我方在那两个精确秒归档的 tick，能否复现场方发布的价格」。

2026-10-18 当天样例中的 291 个 BTC 5 分钟局：我方持有边界秒 tick 的 **559 个，
559/559 全部与场方发布价一致**；另有 23 个边界秒不在我方 feed 中，按不可独立证明
处理、不作判定。比较按场方自己打印的精度进行——我方文件存的是 float64 的完整展开
（`64944.024999999994`），场方打印为 `64944.025`，二者是同一个数、不是分歧。

结算本身可直接在同一文件上算，但计分前有一处需要留意：收在起点价上的局是**平局
退款（push），不算 Up 赢**——场方会把两边都判为赢、本金退回。即
`end_price > start_price` → Up，`end_price < start_price` → Down，
`end_price == start_price` → push。当天为 **139 Up / 152 Down / 0 push**。
平局确实会出现：2026-08-25 的 `btc-updown-5m-1787649300` 开收都是 `79844.005`，
被判为 push。

平局并非可以忽略的边角：在我们的历史数据里，5 分钟局约**每 100 局就有 1 局**收在平局。
另请注意这与 Polymarket 相反——后者的规则把平局判给 Up，所以在本 venue 上用
`>=` 这种二元判据是错的。两个场子的结算规则对照见[结算口径说明](https://outcometick.com/zh/docs/settlement)。

## Verify it yourself / 自行验证

The `verify/` folder holds the code that produces outcometick.com's public
settlement audit — the same files, copied verbatim. It settles every market this
sample can settle on its own (the sample carries the BTC price file only), and
compares each verdict with the audit published for that day. Predict.fun has no
public outcome API to check against, so the outcome is the one its published
start and end prices imply. Node 18+, no dependencies.

`verify/` 目录里就是生成 outcometick.com 公开结算审计的代码（原样复制）。它把本样例
能独立判定的每个市场重算一遍（样例只带 BTC 的价格文件），逐个与当天公开的审计结论比对。
Predict.fun 没有可供核对的公开结果接口，所以官方结果按它公布的开盘价、收盘价推出。
需要 Node 18+，无依赖。

```bash
git clone https://github.com/outcometick/predict.fun-data-samples
curl -L https://github.com/outcometick/predict.fun-data-samples/releases/latest/download/predict-fun-data-samples.tar.gz | tar xz
node predict.fun-data-samples/verify/verify-settlement.mjs --data ./predict-fun-data-samples
```

The published audit: https://outcometick.com/predict-fun-settlement-audit

## Data quality on the sample day / 样例当天的数据质量

- Settlement feed: **85,339 of the day's 86,400 seconds (98.8%)** carried a
  report, with **no gap longer than 4 seconds** across the whole 24 hours.
- Order book: 519,724 snapshots for BTC-5M alone, unthrottled.
- Capture latency for the order book, measured on this day:
  **p50 53 ms, p95 184 ms** (`recv_ms − update_ts_ms`).
- Collection point sits next to the venue's own infrastructure in Tokyo.

You can check the feed-continuity claim yourself: `publish_time` in the price
file is a unix second, so the gap distribution is computable straight from the
sample.

结算价流当天覆盖 86,400 秒中的 **85,339 秒（98.8%）**，**最大间隔 4 秒**；仅
BTC-5M 一个系列就有 519,724 条盘口快照（未限流）；盘口采集延迟当日实测
**p50 53 毫秒、p95 184 毫秒**（`recv_ms − update_ts_ms`）；采集点部署在东京，紧邻
场方基础设施。价格文件的 `publish_time` 是 unix 秒，间隔分布可直接从样例自行核算。

## Known limits — stated up front / 已知限制（先说清楚）

- Prices are **float64 only**. The upstream publishes no full-precision integer
  string for this venue, so none is archived.
- Order book is **snapshots only** — the upstream stream carries no deltas, and
  there is no trade tape. (Our Polymarket dataset does have both.)
- The `provider` column records the channel we subscribe a feed on, not an
  upstream per-tick source. **For data dated 2026-09-03 and earlier it is
  unreliable — ignore it** (it tracked whichever market our discovery loop saw
  last, and one feed is shared by markets declaring different settlement
  sources, so it flipped on our 10s poll; fixed 2026-09-05, and data from 2026-09-04 onward is correct). The price data
  itself was never affected: every tick arrives on one upstream topic and the
  feed carries no per-tick source information, so there is nothing to filter or
  group by here. See `DATA_GUIDE.md`.
- The price feed's upstream timestamps (`publish_time`, `server_ts`) are **whole
  seconds**, so a millisecond-level capture latency cannot be derived for it —
  the quantisation is larger than the latency being measured. `recv_ms` is our
  own millisecond receive time, and the order book does carry a millisecond
  upstream timestamp, which is why the latency figure above is quoted for the
  book only. We would rather omit a number than publish one its inputs cannot
  support.

价格仅 float64（上游无全精度串）；盘口**只有快照**，上游不发增量，也没有成交
流水（我们的 Polymarket 数据集两者都有）；`provider` 列记录的是我们订阅该 feed 所用的
通道，不是上游逐条给出的来源标注，**2026-09-03 及更早的数据里这一列不可靠、请忽略**
（当时它跟随我们的发现循环最后处理到的那个市场，而同一条 feed 被声明了不同结算源的
市场共用，于是随 10 秒轮询来回跳；已于 2026-09-05 修复，2026-09-04 起的数据是正确的）。**价格数据本身从未受影响**：每条 tick 都来自
同一个上游 topic，且该 feed 不携带任何逐条来源信息，无需按此列过滤或分组，详见说明书。
价格流的上游时间戳（`publish_time`、`server_ts`）**只到整秒**，因此无法据此给出
毫秒级采集延迟——量化误差比要测的延迟本身还大；`recv_ms` 是我方毫秒级接收时间，
而盘口带有毫秒级上游时间戳，所以上面的延迟数字只给盘口。**宁可不给一个数字，
也不给一个它的输入撑不起来的数字。**
历史起点 2026-06-12，但**该日为部分覆盖日**（当天中途开采，约占全天 66%），
**首个完整 UTC 日为 2026-06-13**；早期若干天 ETH/BNB 槽位较少（当时只有 daily 市场）。

## Buy / 购买

**[outcometick.com](https://outcometick.com)** — subscribe or buy a date range,
then pull the data with your API key through the
[HTTP API](https://outcometick.com/docs/api). Predict.fun is sold as its own venue tier,
or bundled with Polymarket. It is the same archive these samples come from,
scoped to exactly the assets, data types and dates you purchase.
Weighing it against other sources? See [what to compare when choosing
prediction-market data](https://outcometick.com/compare).

Questions, or something not working:
**[Telegram group](https://t.me/+TcK_hJOzOz5mZTk1)** ·
**[Discord](https://discord.gg/ZDMqkptwm5)** (English and 中文) ·
**support@outcometick.com**

**[outcometick.com](https://outcometick.com)** —— 按订阅或按日期区间购买，用 API
key 经 [HTTP API](https://outcometick.com/zh/docs/api) 自助取数。Predict.fun 可单独作为一个场子购买，也可与 Polymarket 打包。样例即
取自同一份归档，购买后按你选择的币种、数据类型与日期范围开放。
在和其他来源比较？见[选数据时该比什么](https://outcometick.com/zh/compare)。

有疑问或遇到问题：**[Telegram 群](https://t.me/+TcK_hJOzOz5mZTk1)** ·
**[Discord 交流群](https://discord.gg/ZDMqkptwm5)**（中英文分区）·
**support@outcometick.com**
