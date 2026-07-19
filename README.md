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

## Run the demo

Requires foundry (anvil + forge) on PATH and `ANTHROPIC_API_KEY` in the env
(optional — falls back to the deterministic strategist).

    cd agent
    set -a; . C:/Users/ASUS/.claude-apis.env; set +a   # ANTHROPIC_API_KEY
    npm run demo:server        # boots anvil + DemoSetup + server on :8099

Open http://localhost:8099 → click **Apply FX drift** → watch the keeper detect
the at-risk position and, with Claude ranking the vetted paths, rescue it live.
The bottom strip links the same rescue already executed on Arc testnet.

## Repo layout

- `contracts/` — Foundry project (MockOracle, MiniLend, MiniSwap, FirebreakMandate)
- `agent/` — keeper: monitor / strategist / executor
- `evidence/` — every real on-chain rescue, receipts + memos
- `docs/` — [DESIGN.md](docs/DESIGN.md) · [PLAN.md](docs/PLAN.md)

## Status

- [x] Design + plan (2026-07-15)
- [x] Contracts (TDD, forge) — **52 tests green**, incl. fuzz (MockOracle, MockERC20, MiniLend + IPosition, MiniSwap, FirebreakMandate)
- [x] Keeper agent — monitor + strategist + executor; strategist sizing proven 8/8
- [x] Agent v1 — **first real on-chain rescue** end-to-end on a live EVM (local anvil): FX drift pushed HF to 1.120, keeper chose the cheapest bounded path (TOP-UP), HF restored to 1.380 ([evidence](agent/evidence/run-local-001.json))
- [x] LLM strategist — **Claude ranks the vetted rescue paths** and writes the borrower-facing memo; sizing + spend cap + action whitelist stay deterministic, so the model can only pick a bounds-checked path (strict-tool enum + cheapest-path fallback). 11/11 harness tests + [live ranking evidence](agent/evidence/llm-rank-001.json)
- [x] LLM in the loop, on-chain — Claude ranked 3 viable paths and the executor **sent its choice to a live EVM**: HF 1.120 → 1.380, 131.88 USDC from reserve, verified by independent `readContract` ([evidence](agent/evidence/run-local-002.json)). Reproduce: `npm run demo` (see `agent/src/demo.ts`)
- [x] **Live on Arc testnet** — full scenario deployed (chainId 5042002) and the keeper executed a **real LLM-driven rescue on-chain**: Claude ranked 3 viable paths, chose TOP-UP, HF 1.120 → 1.380, spent 0.94 USDC, tx [`0x6041…9869`](https://testnet.arcscan.app/tx/0x6041d281b4d37ae7e599787478e6edb008cc6606a9b7483dd37503105d4d9869) ([evidence](agent/evidence/run-testnet-001.json)). Contracts: Mandate [`0x529D…6915`](https://testnet.arcscan.app/address/0x529D2257dc8BEEA14D02FBc6123a079C08596915), pool [`0x8B52…49a3`](https://testnet.arcscan.app/address/0x8B526D995132dB3F55299A4e19045FE1aC3E49a3)
- [x] Dashboard — single-screen live console (local anvil rescue + Arc-testnet proof strip); `npm run demo:server`
- [x] **Circle Agent Stack** — the keeper runs on a **Circle Agent Wallet** (ERC-4337 smart account) on Arc testnet: Claude ranked the vetted paths and the agent wallet executed the rescue via `circle wallet execute`, no raw private key in the loop. HF 1.120 → 1.380, tx [`0xf608…d78a`](https://testnet.arcscan.app/tx/0xf608f5902aa2fb8bb1b90411dd9c9ab7efc270309dded66a0ab2fc42bc6fd78a) ([evidence](agent/evidence/run-testnet-agentwallet.json) · [design + constraints](docs/CIRCLE-AGENT-STACK.md))
- [x] Demo video — **3-minute pitch + demo** for final submission ([`firebreak-demo-3min.mp4`](video/renders/firebreak-demo-3min.mp4)); 66s short cut also available ([`firebreak-demo.mp4`](video/renders/firebreak-demo.mp4))
