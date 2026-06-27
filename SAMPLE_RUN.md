# Sample run — Lepton Press end-to-end on Arc Testnet

Captured 2026-06-27 (chain `5042002`). One command (`./run.sh`) boots the publisher, runs the
autonomous reader against it, and prints the on-chain revenue ledger. Every settlement below is a
**real StreamPay transaction** on Arc Testnet — click any tx. This is round 1 of the 48-round
traction run, on the canonical publisher.

- **Publisher (payee):** `0xed13AA20701F503304bADB7697cbFD4d0C952Acf`
- **Reader agent:** `0x2e36F4037E711e1d4c853BBCBF7F526B3714A08a`
- **StreamPay:** `0x505739d33D85AD85D0f9eeE64856309782382450`
- **Pricing:** 2 µUSDC/word, floored at 100 µUSDC per paragraph

## What happened

The reader had a task (*"how does an autonomous reader decide which paragraph to pay for"*), a
$0.02 budget, and a stopping rule. It opened **one StreamPay micro-stream** — a USDC time-budget
vesting to the publisher at $0.000333/s — read `agent-reading-economics` paragraph by paragraph
(metering each at its exact price), **scored each against its task**, and on disengagement
(`cancel`) the streamed-but-unwithdrawn balance swept to the publisher while the unstreamed
remainder returned to the reader. No human in the loop.

The relevance column is the agent deciding, transaction by transaction, whether the next paragraph
still pays off: the lead paragraph that answers the task scores high, the tail decays to 0%.

| Step | Settled | Relevance | Tx |
|---|---|---|---|
| Fund — `createStream` ($0.02 over 60s), stream #155 | — | — | [`0x7be4…25af`](https://testnet.arcscan.app/tx/0x7be40028fb1b8e0f8a6cd0abfd477dead70aafdb26deb31da23dfd6b7b0d25af) |
| ¶0 metered | $0.000100 | 60% | [`0xe21f…cbdf`](https://testnet.arcscan.app/tx/0xe21f3aacb431660e4f7f159df52be8f00ed29267d3c7eab8a0208d46c9aecbdf) |
| ¶1 metered | $0.000100 | 20% | [`0x2314…27ef`](https://testnet.arcscan.app/tx/0x23143b794d451ba6d2838f1b3c030ed0a0dce24e1951ca025574c219476e27ef) |
| ¶2 metered | $0.000100 | 0% | [`0x14a6…e0ea`](https://testnet.arcscan.app/tx/0x14a6763f48f88a98b9e855bc63c0b1370e05850302f7011802ded913c3a0e0ea) |
| Settle — `cancel` #155 → $0.006366 to publisher, $0.013334 back to reader | — | — | [`0xc539…b036`](https://testnet.arcscan.app/tx/0xc539ddd709e2db9b61065f606d55233bf717637d8ee2e59c15bb7a57c9a5b036) |

**Result:** 3 paragraphs read, metered at $0.000300; the publisher's full take on this stream was
that plus the **$0.006366** engagement-time sweep = **$0.006666**, settled on-chain. The reader
reclaimed the $0.013334 it never streamed. The gate only releases a paragraph once enough USDC has
vested to the publisher (a `402` is returned until it does) — pay-per-second-of-reading, enforced
on-chain.

## Publisher revenue — this stream

```json
{
  "publisher": "0xed13AA20701F503304bADB7697cbFD4d0C952Acf",
  "stream": 155,
  "meteredReadsUSDC": "0.000300",
  "engagementSettlementUSDC": "0.006366",
  "totalReceivedUSDC": "0.006666"
}
```

The full chain-reconstructed ledger for this publisher (all 50 streams, metered + sweep breakdown,
total **$0.545318**) is in [`runs/STATS_final.json`](runs/STATS_final.json). Raw console transcript
of the full 48-round run: [`runs/TRACTION_1782549148.log`](runs/TRACTION_1782549148.log).
