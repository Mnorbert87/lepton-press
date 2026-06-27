# Security notes — known & accepted

Lepton Press went through three independent pre-submission audits. The findings that warranted
code changes were fixed (signature replay-hardening, deterministic per-paragraph settlement,
CSP lockdown, withdraw-queue timeout, vendored + reproducible StreamPay source). The two items
below are **known, accepted design trade-offs** for a testnet demo, documented here for honesty
rather than fixed.

## E — Hop-2 of the broker is not atomic delivery-versus-payment (DvP)

In the two-hop value chain (`broker.js`), the consumer pays the broker over a StreamPay stream
and the broker withdraws it, then "delivers" the synthesized answer. Settlement and delivery are
two separate steps, not one atomic swap — so in principle either side must extend a little trust
across the gap (the broker could take payment without delivering, or a delivered answer could be
copied without the consumer having paid first).

For this demo both agents are cooperative and the amounts are nano-scale on testnet, so the gap
is harmless. A production version would close it with an atomic primitive — e.g. a
commit-reveal / hash-locked answer, or settling the answer's hash on-chain so payment and
delivery bind together. **Accepted for the submission; flagged as the one trust assumption in
the chain.**

## G — The publisher's in-memory ledger is a cache, not the source of truth

`server.js` keeps an in-memory revenue ledger (`/stats`) so the dashboard renders instantly. It
is **not** authoritative: it resets on restart and only reflects settlements this process saw.

The source of truth is the chain. Every paragraph release is a real StreamPay `withdraw()`; the
creator dashboard (`web/index.html`) reconstructs all revenue directly from on-chain
`Created`/`Withdrawn` events, and every settlement links to its arcscan transaction. If the
in-memory ledger and the chain ever disagree, **the chain wins**. **Accepted by design.**
