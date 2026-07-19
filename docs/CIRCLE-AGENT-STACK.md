# Circle Agent Stack integration — design, constraints, runbook

**Status:** designed + researched; live wiring blocked on two human-only steps (below).
**Why:** the hackathon's judging criteria call for "use of the right core products — App Kits for payment/liquidity flows and **Agent Stack for agentic builds** where relevant." Firebreak's keeper is exactly an Agent-Stack-shaped workload: an autonomous agent that holds funds and transacts under bounded authority.

## The thesis fit

Firebreak's core claim is that **an agent's authority should be a bounded object, not a promise**. Today that bound lives in one place:

- **On-chain:** the `FirebreakMandate` contract enforces HF trigger, per-rescue spend cap, and action whitelist at execution time.

Circle Agent Wallets add a *second, independent* bound at the wallet layer — spend policies enforced by Circle before a transaction ever reaches the chain. Two different systems, both saying no. That's defense in depth, and it's the same idea expressed twice:

```
borrower's Mandate  ──enforces──▶  what the keeper may do      (on-chain, Firebreak)
Circle wallet policy ─enforces──▶  what the keeper may spend   (off-chain, Circle)
```

## Verified facts (checked 2026-07-20)

| Fact | Source |
|---|---|
| Agent Wallets support **`ARC-TESTNET`** | [supported-blockchains](https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains) — "Agent Wallets support the following blockchains on both mainnet and testnet, **except Arc Testnet (testnet only)**" |
| CLI is `@circle-fin/cli` (v0.0.6 installed), Node ≥ 20.18.2 | `npm install -g @circle-fin/cli` |
| Agent wallet creation requires email-OTP auth | `circle wallet create` → "(requires auth)"; `circle wallet login` → "Log in with email OTP" |
| **Spending policies are mainnet-only** | `circle wallet limit --help` → "`-c, --chain <chain>` Mainnet blockchain (required; **testnets not supported**)" |
| Setting a policy additionally requires human OTP | `circle wallet limit set` → "(human OTP required)" |
| CLI requires accepting Terms of Use before any command | `CIRCLE_ACCEPT_TERMS=1` documented for non-interactive use |

### The honest constraint

**Arc is testnet-only for Agent Wallets, and spend policies are mainnet-only.** These two facts do not overlap. So on Arc testnet we can run the keeper *on* a Circle Agent Wallet, but we **cannot** demonstrate the wallet-policy guardrail there.

We state this plainly rather than implying a policy layer we haven't run. On Arc testnet the **Mandate contract is the enforcing layer**; the Circle policy layer becomes the second bound when Arc reaches mainnet (or when the keeper runs on a mainnet chain).

## Integration design

The keeper currently signs with a raw private key (`walletFor(keeperKey)` in `agent/src/chain.ts`). The integration swaps the *signing/broadcast* layer only — decision logic, sizing, bounds-checking, and the Mandate contract are untouched:

```
monitor → strategist (Claude ranks vetted paths) → executor
                                                      │
                                    ┌─────────────────┴─────────────────┐
                                    ▼                                   ▼
                          viem + raw key                  Circle Agent Wallet
                          (today, local/testnet)          (`circle wallet execute`)
```

Both paths call the same `FirebreakMandate.rescue(user, plan)`. The executor picks the signer by config, so evidence produced by either path is directly comparable — the on-chain effect is identical, which is the point.

### Target commands

```bash
# one-time, human
circle wallet login you@example.com --testnet     # email OTP
circle wallet create --chain ARC-TESTNET

# per keeper run
circle wallet list --type agent --chain ARC-TESTNET      # keeper address
circle wallet fund --address 0xKEEPER --chain ARC-TESTNET  # testnet faucet drip
circle wallet balance --address 0xKEEPER --chain ARC-TESTNET
circle wallet execute --address 0xKEEPER --chain ARC-TESTNET \
  --contract 0x529D2257dc8BEEA14D02FBc6123a079C08596915 \
  --function "rescue(address,(uint8,address,uint256,address,uint256,uint256,uint256))" \
  --args ...
```

`circle wallet execute` is the executor hook — it performs the contract write that today goes through viem.

## Blocked on (human-only, ~3 minutes)

These cannot be done by an agent on the user's behalf — they are a legal acceptance and an identity verification:

1. **Accept the Circle CLI Terms of Use.** Either run any `circle` command interactively and accept, or set `CIRCLE_ACCEPT_TERMS=1` yourself if you agree to them ([terms](https://agents.circle.com/terms-of-use)).
2. **`circle wallet login <your-email> --testnet`** and enter the OTP sent to that address.

After those two steps: `circle wallet create --chain ARC-TESTNET`, then the executor can be pointed at the agent wallet and a rescue re-run to produce `evidence/run-testnet-agentwallet.json`.

## What this buys at judging

- Criterion ② ("use of the right core products") moves from *not addressed* to *the keeper runs on Circle Agent Wallets on Arc*.
- The wallet-policy story becomes a credible, specific roadmap item rather than hand-waving — we can point at the exact CLI surface and say why it's mainnet-only today.

## Other Agent Stack components — assessed, not adopted

Considered and deliberately skipped, with reasons (better to use one component properly than name five):

- **Nanopayments / Gateway** — gasless sub-cent USDC. Real fit *later*: paying per-call for a price oracle or a liquidation-risk feed. Contrived today, since our oracle is local.
- **Agent Marketplace** — for discovering paid services. Firebreak consumes no third-party paid service yet.
- **Circle Skills** — `circle skill install` pulls Circle's knowledge modules into a coding agent. Useful to the developer, but it isn't part of the product.
