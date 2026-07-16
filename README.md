# Firebreak

**The liquidation firewall for stablecoin-native lending on Arc.**

> Liquidation is a fire. By the time you smell smoke, it's too late.
> Firebreak is the line the fire can't cross.

Borrowers sign an **on-chain Mandate** — a bounded, conditional authorization (HF trigger, per-rescue spend cap, action whitelist). An autonomous keeper agent watches loan health and, before liquidators can move, executes the cheapest rescue — deleverage, rotate collateral, or top up — in a single atomic transaction, settled sub-second in USDC.

**Programmable Money Hackathon** (Encode × Arc × Circle) · July 13 – Aug 9, 2026 · Tracks: **DeFi** + **Agentic Economy**

## Why Arc

- Collateral on a stablecoin-native L1 is FX (EURC) and tokenized RWAs — health factors **drift** slowly instead of flash-crashing. Drift is what automation catches and humans miss.
- **Sub-second settlement**: the rescue lands before the liquidator.
- **USDC-denominated gas**: the keeper's economics are in the same unit as the savings.

## Architecture

```
                    ┌─────────────────────────────┐
   signals          │  Agent (TypeScript)          │
  HF, prices,   ──▶ │  monitor → LLM strategist    │
  swap quotes       │  (memo) → executor           │
                    └──────────────┬──────────────┘
                                   │ rescue(user, plan)
                                   ▼
                    ┌─────────────────────────────┐
                    │  FirebreakMandate.sol        │  bounded, conditional,
                    │  HF<trigger? plan in bounds? │  non-custodial
                    └──────┬───────────────┬──────┘
                           ▼               ▼
                    MiniLend.sol      MiniSwap.sol
                   (IPosition)       (native USDC ↔ ERC20)
```

- **LLM decides, contracts execute**: the model picks the cheapest rescue path and writes a reasoning memo; execution is deterministic and doubly bounds-checked (off-chain + on-chain).
- **Protocol-agnostic**: the keeper speaks `IPosition` — MiniLend is just the first adapter.

## Repo layout

- `contracts/` — Foundry project (MockOracle, MiniLend, MiniSwap, FirebreakMandate)
- `agent/` — keeper: monitor / strategist / executor
- `evidence/` — every real on-chain rescue, receipts + memos
- `docs/` — [DESIGN.md](docs/DESIGN.md) · [PLAN.md](docs/PLAN.md)

## Status

- [x] Design + plan (2026-07-15)
- [x] Contracts (TDD, forge) — **50 tests green**, incl. fuzz (MockOracle, MockERC20, MiniLend + IPosition, MiniSwap, FirebreakMandate)
- [x] Keeper agent — monitor + strategist + executor; strategist sizing proven 8/8
- [x] Agent v1 — **first real on-chain rescue** end-to-end on a live EVM (local anvil): FX drift pushed HF to 1.120, keeper chose the cheapest bounded path (TOP-UP), HF restored to 1.380 ([evidence](agent/evidence/run-local-001.json))
- [x] LLM strategist — **Claude ranks the vetted rescue paths** and writes the borrower-facing memo; sizing + spend cap + action whitelist stay deterministic, so the model can only pick a bounds-checked path (strict-tool enum + cheapest-path fallback). 11/11 harness tests + [live ranking evidence](agent/evidence/llm-rank-001.json)
- [x] LLM in the loop, on-chain — Claude ranked 3 viable paths and the executor **sent its choice to a live EVM**: HF 1.120 → 1.380, 131.88 USDC from reserve, verified by independent `readContract` ([evidence](agent/evidence/run-local-002.json)). Reproduce: `npm run demo` (see `agent/src/demo.ts`)
- [ ] Arc testnet deployment — script ready (`contracts/script/deploy-testnet.sh`); pending RPC quota window
- [ ] Dashboard + demo video
