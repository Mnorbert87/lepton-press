# Real testnet traction — Lepton Press on Arc

Every number below is a **real on-chain settlement** on Arc Testnet (chain `5042002`) to one
publisher address. Autonomous reader agents stream a USDC reading-budget to the publisher and
settle it as they read — metered paragraph by paragraph while reading, and the streamed
remainder swept to the publisher when the agent disengages. No mocks, no off-chain accounting:
every figure here is reconstructed directly from StreamPay `Created` / `Withdrawn` / `Cancelled`
events on Arc. Canonical publisher: `0xed13…2Acf`.

## Headline

| Metric | Value |
|---|---|
| StreamPay micro-streams opened to the publisher | **50** (`createStream`) |
| Paragraphs metered on-chain | **182** (`withdraw()` settlements) |
| Streams settled & reclaimed | **50** (`cancel`) |
| **Total on-chain settlement txns** | **~282** |
| **Total publisher revenue (on-chain)** | **$0.545318 USDC** |
| — metered proof-of-read (`withdraw`) | $0.020314 (≈3.7%) |
| — engagement-time settlement (`cancel` → recipient) | $0.525004 (≈96.3%) |
| Human actions | **0** |

- **Publisher (payee):** [`0xed13AA20701F503304bADB7697cbFD4d0C952Acf`](https://testnet.arcscan.app/address/0xed13AA20701F503304bADB7697cbFD4d0C952Acf)
- **Reader agent:** [`0x2e36F4037E711e1d4c853BBCBF7F526B3714A08a`](https://testnet.arcscan.app/address/0x2e36F4037E711e1d4c853BBCBF7F526B3714A08a)
- **StreamPay:** [`0x505739d33D85AD85D0f9eeE64856309782382450`](https://testnet.arcscan.app/address/0x505739d33D85AD85D0f9eeE64856309782382450)

## How the publisher earns (the revenue is a streamed retainer, not a per-paragraph charge)

This is the load-bearing point, and it is honest about where the money comes from. The reader
does **not** pay a flat per-paragraph fee. It opens **one StreamPay micro-stream** — a USDC
time-budget that vests to the publisher second by second — and that budget settles to the
publisher two ways:

1. **Metered proof-of-read** — while reading, the publisher pulls `withdraw(streamId, exactPrice)`
   for each paragraph: the precise word-count price of the paragraph being released, never a round
   vesting slice. This is the granular, per-paragraph proof that a specific paragraph was served.
   Across the run this is **$0.020314** (the 182 `withdraw` settlements).
2. **Engagement-time settlement** — the reader's committed budget vests on the clock. When the
   agent disengages (`cancel`), the streamed-but-unwithdrawn balance is swept **to the publisher**
   (`toRecipient`), and only the *unstreamed* remainder returns to the reader (`toSender`). This is
   the publisher's retainer for the agent's engaged time: **$0.525004** across the 50 cancels.

Together that is **$0.545318** the address actually received — the headline number, and exactly
what the creator dashboard and arcscan show. The split (~3.7% metered / ~96.3% engagement-time) is
the model working as designed: an agent buys *attention-time* on the publisher's content, settled
continuously, with per-paragraph metering as the on-chain proof-of-engagement underneath it.

## The metered pulls are exact paragraph prices (not round slices)

The `withdraw` amounts are the precise word-count prices from the public price list, never a
rounded vesting cut — proof the metering tracks real content, not an arbitrary draw:

| Settled amount | Count |
|---|---|
| $0.000100 | 72 |
| $0.000112 | 42 |
| $0.000120 | 21 |
| $0.000122 | 21 |
| $0.000128 | 26 |

(182 metered settlements; `$0.000100` is the per-paragraph dust floor, the rest are word-count
prices.)

## The agent is actually deciding (not draining)

The relevance score is the agent choosing, transaction by transaction, whether the next paragraph
is still worth reading. Across the 182 settlements the scores span the full range — high where the
paragraph answers the task, zero on the off-topic tail that triggers the stop:

| Relevance bucket | Settlements |
|---|---|
| 0% (off-topic → counts toward stop) | 61 |
| 13–40% | 74 |
| 50–60% | 24 |
| 75–100% (on-target) | 23 |

That spread is the whole thesis: per-read economics made legible. An agent that simply drained its
budget would show no variance and never stop early — these stop the moment the content stops paying
off.

## Representative run (click to verify)

One run reading `arc-nanopayments` ("Why the smallest payment is the hardest one"), budget $0.02 —
the agent meters each paragraph at its exact price, stops once the task saturates, and `cancel`
splits the stream: the vested-but-unwithdrawn slice sweeps to the publisher, the unstreamed
remainder returns to the reader.

| Step | Settled | Relevance | Tx |
|---|---|---|---|
| `createStream` #203 ($0.02 budget) | — | — | [`0xc7c6…5cbf`](https://testnet.arcscan.app/tx/0xc7c67cbef249dd4a2dcc86b673d554d888282c3709f412b9f6fb848eb3845cbf) |
| ¶0 metered | $0.000112 | 20% | [`0x1db8…7f1d`](https://testnet.arcscan.app/tx/0x1db828be3335253a53ebe677007458117a8b781387db9a1d6db2109ec79c7f1d) |
| ¶1 metered | $0.000128 | 40% | [`0x82e9…015b`](https://testnet.arcscan.app/tx/0x82e990d830ac67a33e045b2a73ef8d1c61850e3ab18b18147b1248714889015b) |
| ¶2 metered | $0.000120 | 20% | [`0xb640…1cfe`](https://testnet.arcscan.app/tx/0xb640e6a647e95c10f86dba8a4208f79d2c47cdf9d5933015045c903dc96b1cfe) |
| ¶3 metered | $0.000122 | 0% | [`0xe1bc…767b`](https://testnet.arcscan.app/tx/0xe1bc42c7c89344c41139763a1ddf7c3dd074b36dcfc5af0b012a02196bc3767b) |
| ¶4 metered | $0.000112 | 0% | [`0x01cd…1629`](https://testnet.arcscan.app/tx/0x01cdc765e2361a9b64512927c828ca74fb8812e5472453d897201c2f3b181629) |
| `cancel` #203 → $0.009406 to publisher, $0.010000 back to reader | — | — | [`0x471e…8045`](https://testnet.arcscan.app/tx/0x471ea1c40d3a4f8382efb16e5dfa746639ce169fc5d4a750cf638d1e238f8045) |

Metered reads totalled $0.000594; the publisher's full take on this stream was that plus the
$0.009406 engagement-time sweep = **$0.010000**, settled one on-chain tx at a time. The complete
chain-reconstructed ledger (metered + sweep breakdown, every figure for this address) is in
[`runs/STATS_final.json`](runs/STATS_final.json); the raw 48-round reader log is
[`runs/TRACTION_1782549148.log`](runs/TRACTION_1782549148.log).

## Verify it yourself

The creator dashboard reconstructs all of this straight from on-chain StreamPay events — no
backend, no trust in this file. It scans both revenue components (metered `Withdrawn` +
`Cancelled` sweeps) and shows the breakdown live:

```
web/index.html?publisher=0xed13AA20701F503304bADB7697cbFD4d0C952Acf
```

> **Canonical proof = the per-settlement arcscan tx links above** (transaction receipts are
> permanent and reproduce exactly). The live dashboard reads historical `eth_getLogs` from the
> public Arc RPC, which is load-balanced across nodes whose log indices can return *partial*
> history for older ranges — so a fresh dashboard load days after the run may show fewer
> settlements than the tx links prove. If it looks short, refresh; the per-settlement tx hashes
> remain the ground truth either way.

> Testnet only (chain `5042002`). USDC is the native gas token, so each of the ~282 txns also
> burned a fraction of testnet USDC in gas — paid by the agents, no human in the loop. Real
> settlement, real (test) money.
