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
       MiniLend.sol / ScaledLend.sol      MiniSwap.sol
        (two IPosition adapters)       (native USDC ↔ ERC20)
```

- **LLM decides, contracts execute**: the model picks the cheapest rescue path and writes a reasoning memo; execution is deterministic and doubly bounds-checked (off-chain + on-chain).
- **Protocol-agnostic, and tested as such**: the keeper speaks `IPosition`. Two adapters back it — `MiniLend` (raw amounts) and `ScaledLend` (share-based collateral, index-accrued debt, Aave/Compound style). The same Mandate bytecode guards both, so the claim is falsifiable rather than self-certified.

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

- `contracts/` — Foundry project (FirebreakMandate · MiniLend + ScaledLend as two `IPosition` adapters · MiniSwap · MockOracle · MockERC20)
- `agent/` — keeper: monitor / strategist / executor, plus the cross-chain reserve loop (`reserve.ts` policy, `unified-balance.ts` Circle SDK shim, `reserve-status.ts` report)
- `agent/evidence/` — every real on-chain rescue, receipts + memos
- `web/` · `deck/` · `video/` — hosted replay, pitch deck, 3-minute demo
- `docs/` — [DESIGN.md](docs/DESIGN.md) · [PLAN.md](docs/PLAN.md) · [CIRCLE-AGENT-STACK.md](docs/CIRCLE-AGENT-STACK.md)

## Status

- [x] Design + plan (2026-07-15)
- [x] Contracts (TDD, forge) — **75 tests green**, incl. fuzz (MockOracle, MockERC20, MiniLend + ScaledLend as two IPosition adapters, MiniSwap, FirebreakMandate)
- [x] Keeper agent — monitor + strategist + executor; strategist sizing proven 10/10
- [x] Agent v1 — **first real on-chain rescue** end-to-end on a live EVM (local anvil): FX drift pushed HF to 1.120, keeper chose the cheapest bounded path (TOP-UP), HF restored to 1.380 ([evidence](agent/evidence/run-local-001.json))
- [x] LLM strategist — **Claude ranks the vetted rescue paths** and writes the borrower-facing memo; sizing + spend cap + action whitelist stay deterministic, so the model can only pick a bounds-checked path (strict-tool enum + cheapest-path fallback). 11/11 harness tests + [live ranking evidence](agent/evidence/llm-rank-001.json)
- [x] LLM in the loop, on-chain — Claude ranked 3 viable paths and the executor **sent its choice to a live EVM**: HF 1.120 → 1.380, 131.88 USDC from reserve, verified by independent `readContract` ([evidence](agent/evidence/run-local-002.json)). Reproduce: `npm run demo` (see `agent/src/demo.ts`)
- [x] **Live on Arc testnet** — full scenario deployed (chainId 5042002) and the keeper executed a **real LLM-driven rescue on-chain**: Claude ranked 3 viable paths, chose TOP-UP, HF 1.120 → 1.380, spent 0.94 USDC, tx [`0x57be…ae74`](https://testnet.arcscan.app/tx/0x57be4221ed1258879fb57a4c8fd378b0a82462424b022408cb46060d3465ae74) ([evidence](agent/evidence/run-testnet-001.json)). Contracts: Mandate [`0xf263…3a18`](https://testnet.arcscan.app/address/0xf26397EA0491d958d8f1d12C90DcB371101F3a18), pool [`0x6E20…45fb`](https://testnet.arcscan.app/address/0x6E2075FD748415d687509f301773c47252E745fb)
- [x] Dashboard — single-screen live console (local anvil rescue + Arc-testnet proof strip); `npm run demo:server`
- [x] **Circle Agent Stack** — the keeper runs on a **Circle Agent Wallet** (ERC-4337 smart account) on Arc testnet: Claude ranked the vetted paths and the agent wallet executed the rescue via `circle wallet execute`, no raw private key in the loop. HF 1.120 → 1.380, tx [`0xbdab…0e81`](https://testnet.arcscan.app/tx/0xbdabd54e0a3dcda9d3f8c2c7810700f5e472dcebd585649c879751be6b210e81) ([evidence](agent/evidence/run-testnet-agentwallet.json) · [design + constraints](docs/CIRCLE-AGENT-STACK.md))
- [x] Demo video — **3-minute pitch + demo** on [YouTube](https://youtu.be/2gbuq-k4IHo) (180s, incl. the Circle Agent Wallet rescue) for final submission ([source mp4](video/renders/firebreak-demo-3min.mp4)); 66s short cut also available ([`firebreak-demo.mp4`](video/renders/firebreak-demo.mp4))
- [x] **Cheapest ≠ best** — a scenario where the free TOP-UP only *partially* restores health (1.266, still at risk) while ROTATE fully reaches 1.380 for 0.36 USDC. The deterministic cheapest-by-cost rule gets this wrong; Claude, seeing each path's projected HF, picks the durable fix. Executed HF 1.190 → 1.602 ([evidence](agent/evidence/run-local-flagship.json))
- [x] **The counterfactual** — twin positions drift; the protected one keeps **83/100 mEURC and is never liquidated**, the unprotected twin has all 100 seized ([evidence](agent/evidence/run-local-twin.json))
- [x] **Cross-chain reserve** (Circle App Kits / Unified Balance) — the rescue reserve lives on any chain the borrower already holds USDC on; the keeper refills Arc in a second loop when it drops below a floor, never inside a rescue, so rescues stay atomic. Authorization mirrors the Mandate: `register(Terms)` on Arc, `addDelegate(USDC, keeper)` on Circle, and revoking either alone stops the keeper. Verified live against Circle Gateway (Arc Testnet at chainId 5042002, 12 testnets usable as sources). `npm run reserve -- <borrower>`
- [x] **Protocol-agnostic, falsified** — `ScaledLend`, a second pool with share-based collateral and index-accrued debt (Aave/Compound style), guarded by the **same Mandate bytecode**. It also expresses a risk MiniLend cannot: interest accrues every second, so health decays with the market perfectly still
- [x] **Keeper economics** — a flat fee fixed at signing, paid only after a successful rescue. Flat rather than a percentage, so the keeper is indifferent to rescue size; and it cannot farm frequency, because a rescue must lift health out of the band it would need to re-enter to bill again. An underfunded reserve costs the keeper its fee, never the borrower the rescue
- [x] **Audited our own late-build code** — found and fixed an unguarded `setExchangeRate` (anyone could inflate their own collateral), an amount rendered through `Number()` on the transfer path (lost precision, emitted `1e-9`), and a policy that could produce a negative refill. All pinned by tests that mount the attack. **120 tests total** (75 Foundry incl. fuzz · 11 LLM-safety · 16 reserve policy · 8 amount rendering · 10 strategist)
