# Lepton Press

**A nanopayment paywall for the agentic web.** Publishers get paid in **streamed USDC** —
metered paragraph by paragraph, a few millionths of a dollar each — as autonomous AI agents
stream a reading budget that settles on [Arc](https://arc.io) as they consume the text. No
card floor, no subscription, no API key.

Built for the **Lepton Agents Hackathon** (Canteen × Circle × Arc).

> A card payment cannot charge a tenth of a cent — the fee floor kills the long tail of
> writing. Arc + USDC nanopayments can. Here a publisher earns from agents reading its
> content — a streamed time-budget settled paragraph by paragraph — live on Arc, with no
> human in the loop.

## The mechanism

```
reader agent                         publisher (payee)                    Arc Testnet
------------                         -----------------                    -----------
GET /article/:id          ───────▶  200  table of contents + per-¶ prices (free)

createStream(publisher, budget, …)  ─────────────────────────────────▶   StreamPay #N
                                     (the reader's committed budget, vesting per second)

GET /article/:id/p/0?stream=N&sig=…  ▶  verifies the caller owns stream N, withdraw()s vested ──▶ real Arc tx
                          ◀───────  200 { text, settlementTx }
   …agent scores the paragraph against its task, buys the next only if it still pays off…

cancel(N)                 ─────────────────────────────────────────────▶   reclaim unused
```

- **Per-paragraph nanopricing.** Each paragraph is priced at `2 µUSDC × word count`, floored at
  a small per-settlement dust floor (`MIN_SETTLE_UUSDC`, 100 µUSDC) — about $0.0001 either way, a
  price no card rail can serve. A paragraph unlocks once that **effective** price has vested on the
  stream, and the publisher pulls **exactly it** on chain — so the settlement tx, the
  table-of-contents `priceUSDC`, and this figure all match (the table of contents advertises the
  floored price, never less than what settles). Any streamed-but-unwithdrawn remainder stays in the
  stream and is swept to the publisher (or reclaimed by the reader) at `cancel`. Pricing is public
  in the free table of contents.
- **StreamPay as the rail.** The reader opens one micro-stream and the publisher pulls the
  USDC that has vested as it releases each paragraph. Pay-per-second-of-reading, not a flat
  charge. Either side can stop at any block.
- **The gate is on-chain.** A paragraph is released **only after** a successful on-chain
  `withdraw()`; the settlement tx hash is returned with the text.
- **Only the funder can spend a stream.** Stream ids are sequential and public, so each
  request must carry a fresh signature from the stream's funding key (`sig`/`ts`); the
  publisher recovers the signer and refuses to settle a stream for anyone but its sender.
  A passer-by who guesses an id cannot drain another reader's budget or read on their dime.
- **No dust settlements.** A `withdraw()` costs gas the publisher pays, so the server never
  settles less than a small floor (`MIN_SETTLE_UUSDC`) — it waits for enough to vest first,
  which also stops an attacker from griefing the publisher into net-negative gas burn.
- **The agent decides.** The reader has a task, a budget, and a stopping rule: it scores
  each paragraph against its goal and stops paying once the marginal paragraph no longer
  earns its price. Per-read economics, made legible transaction by transaction.

## Which Lepton RFBs this answers

| RFB | How |
|-----|-----|
| **#6 Creator & Publisher Monetization** (primary) | publishers earn from machine readers — metered reads plus the streamed engagement-time they settle |
| #1 Autonomous paying agent | the reader discovers the paywall and pays with no human |
| #2 Per-call monetized service | every paragraph is a metered, priced good |
| #4 Streaming / pay-per-second | StreamPay vests the budget per second of reading |
| #5 Nanopayment tooling | the x402 paywall middleware + reader SDK |

## Run it

Needs Node 18+ and two funded Arc-Testnet **burner** keys (USDC is the gas token; get test
USDC at https://faucet.circle.com).

```bash
npm install
cp .env.example .env          # fill SERVER_PRIVATE_KEY + AGENT_PRIVATE_KEY (dedicated burners)

./run.sh                      # one command: boots publisher, runs reader, prints the ledger
```

…or drive the two sides by hand:

```bash
SERVER_PRIVATE_KEY=0x… node server.js     # terminal 1 — the publisher / paywall
AGENT_PRIVATE_KEY=0x…  node reader.js      # terminal 2 — the autonomous reader
```

The reader prints each paid paragraph with its live arcscan settlement link, then reclaims
its unspent budget.

## Creator dashboard

`web/index.html` is a **zero-backend** dashboard: it reads the publisher's revenue straight
from Arc by scanning StreamPay `Created`/`Withdrawn` events — no server, no database, hostable
on GitHub Pages. Open it with the publisher address:

```
web/index.html?publisher=0xYOUR_PUBLISHER_ADDRESS&start=<block-before-demo>
```

It shows total nano-revenue, paragraphs sold, distinct paying streams, per-article earnings,
and recent settlements with arcscan links — refreshed live. `?start=` pins the first block to
scan (Arc RPC caps `eth_getLogs` ranges, so the page walks the window in 9k-block chunks);
omit it to look back a recent window.

## Files

| File | What |
|------|------|
| `server.js`  | The publisher: serves a free table of contents and 402-gates each paragraph, settling via StreamPay `withdraw()`. |
| `reader.js`  | The autonomous reader: opens the stream, settles paragraph by paragraph as it reads, scores relevance, stops when the task is saturated, reclaims the remainder. |
| `content.js` | The article catalogue + the per-word nanopricing. |
| `web/index.html` | Zero-backend creator dashboard — reads revenue live from Arc StreamPay events. |
| `run.sh` | One-command end-to-end demo (publisher + reader + ledger). |

## Arc Testnet reference

| | |
|---|---|
| RPC | `https://rpc.testnet.arc.network` |
| Chain ID | `5042002` |
| Gas token | **USDC** (native) — `0x3600000000000000000000000000000000000000` |
| StreamPay | `0x505739d33D85AD85D0f9eeE64856309782382450` (deployed, source-verified, adversarially tested) |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |

## Security

- Keys are read at runtime; `.env` and `node_modules` are gitignored. **No key is ever
  committed or logged.** Use dedicated burner wallets only.
- StreamPay is the settlement primitive ([arc-agentic-stack](https://github.com/Mnorbert87/arc-agentic-stack)),
  carrying its own invariant/fuzz/adversarial Foundry suite + security-audit doc. Lepton Press adds no
  custody of its own — the publisher only ever pulls what has vested to it.
