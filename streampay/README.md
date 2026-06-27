# StreamPay — vendored source & reproducible-bytecode proof

Lepton Press settles every paragraph over **StreamPay**, a continuous USDC payment-streaming
primitive already deployed and source-verified on Arc testnet. Lepton Press itself deploys **no
new contract** — this directory vendors the exact StreamPay source so the "source-verified"
claim is auditable straight from this repo, not on trust.

## Deployment (the trust root)

| | |
|---|---|
| Address | [`0x505739d33D85AD85D0f9eeE64856309782382450`](https://testnet.arcscan.app/address/0x505739d33D85AD85D0f9eeE64856309782382450) |
| Chain | Arc testnet (chain id `5042002`) |
| Deploy tx | [`0xce67f7d7ef03c2899db810e60a3e18ff239811f8b8f655e418573b102a7770d0`](https://testnet.arcscan.app/tx/0xce67f7d7ef03c2899db810e60a3e18ff239811f8b8f655e418573b102a7770d0) |
| Constructor arg | `usdc = 0x3600000000000000000000000000000000000000` (Arc native USDC, immutable) |
| Source-verified | Yes — arcscan `getsourcecode` returns the full source + ABI |

## Exact build settings (required to reproduce the bytecode)

| Setting | Value |
|---|---|
| Compiler | `solc 0.8.24+commit.e11b9ed9` |
| Optimizer | enabled, `runs = 200` |
| EVM version | `cancun` |
| External deps | **none** — `IERC20` and `ReentrancyGuard` are inlined in `StreamPay.sol` (no OpenZeppelin, no remappings) |
| License | MIT |

`foundry.toml` in this directory pins exactly these settings.

## Reproduce & verify the on-chain bytecode yourself

```bash
forge build --root .
# compare the recompiled runtime to the live contract:
cast code 0x505739d33D85AD85D0f9eeE64856309782382450 --rpc-url https://rpc.testnet.arc.network
# vs out/StreamPay.sol/StreamPay.json -> .deployedBytecode.object
```

**Verified result (2026-06-26):** the recompiled runtime is **byte-identical (4912 bytes)** to
the on-chain code except for the two expected, execution-irrelevant regions:

1. **5 single bytes** of the inlined `immutable usdc` address (`0x36…` from the constructor
   arg) — these are zero in a stand-alone compile because the immutable is set at deploy time.
2. The trailing **Solidity metadata CBOR hash** (the `ipfs` digest before `64736f6c6343000818`
   = solc `0.8.24`). Both ends carry the same compiler tag; only the metadata hash differs,
   which never affects execution.

That is the standard "functional exact match": identical runtime logic, with only the
deploy-time immutable and the metadata trailer differing — exactly what source-verification on
the explorer attests.

## Provenance

`StreamPay.sol` here is byte-identical to the canonical source in the builder monorepo's
`contracts/stream-pay/src/StreamPay.sol`, which carries the full Foundry test + adversarial +
solvency-invariant suite. The contract is unmodified by Lepton Press; this copy exists solely
so the deployed bytecode's trust root can be re-derived from the submission repo.
