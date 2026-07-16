# Firebreak — The Liquidation Firewall for Stablecoin-Native Lending on Arc

> **Checkpoint 2 progress submission** · Programmable Money Hackathon (Encode × Arc × Circle)

**Project:** Firebreak — a non-custodial liquidation firewall. Borrowers sign an on-chain Mandate; an autonomous keeper agent watches loan health and, before liquidators can move, executes the cheapest bounded rescue in a single atomic transaction.
**Circle account email:** wangligang16161616@gmail.com
**Tracks:** DeFi (primary) + Agentic Economy — the product is a DeFi primitive *and* an autonomous agent with money at stake.
**Repo:** https://github.com/wanggang22/firebreak
**Live demo:** https://firebreak-site-wanggang22s-projects.vercel.app — an interactive replay of the real Arc testnet rescue (drift → Claude ranks → TOP-UP → health restored), with clickable arcscan proof. Run the fully-live version locally with `npm run demo:server`.

---

## Problem

Liquidation is the worst outcome in lending, and it's almost always avoidable. A borrower's health factor doesn't flash-crash — it **drifts**: FX moves, an RWA re-prices, interest accrues. By the time the position crosses the liquidation line, a liquidator bot has already been waiting, and it takes a 5–10% penalty out of the borrower's collateral. The borrower could have fixed it with a tiny top-up or a collateral swap hours earlier — but nobody was watching at 3am, and even if they were, a manual "approve this transaction" flow is too slow and gives a bot custody-shaped power.

Arc makes this failure especially sharp: collateral here is FX (EURC) and tokenized RWAs (T-bills) whose prices *drift* slowly. Drift is exactly what automation catches and humans miss.

## What we're building

Firebreak lets a borrower sign a **Mandate** — a bounded, conditional, non-custodial authorization stored on-chain:

- **Trigger:** act only when health factor < X (e.g. 1.20)
- **Spend cap:** never move more than Y USDC per rescue
- **Action whitelist:** any subset of `{ DELEVERAGE, ROTATE, TOP-UP }`

An autonomous keeper agent then monitors the loan and, when health crosses the trigger, executes the **cheapest rescue that fits the Mandate** — in one atomic transaction, settled sub-second in native USDC. The keeper can never exceed the cap, take an un-whitelisted action, or touch funds outside the rescue: the `FirebreakMandate` contract re-checks every bound on-chain, so authorization is real, not trust.

**The agentic core — "LLM ranks, deterministic code sizes + bounds-checks":**
The deterministic strategist sizes *every* allowed rescue path to restore health to a safe margin, prices each, and drops any that breach the spend cap — producing a vetted candidate set. **Claude (claude-opus-4-8) then ranks that set** and writes the borrower-facing reasoning memo, constrained by a strict-tool enum of viable action ids, so it can only ever pick a bounds-checked path. Any error, or an out-of-set pick, falls back to the cheapest path. The model's only freedom is *which safe rescue* — never *whether it's safe*. That's genuine autonomy (a judgment with real money at stake) with none of the "LLM does math wrong and drains the position" risk.

## Progress so far (CP2)

**Contracts — done, live on Arc testnet, 50 forge tests green (incl. fuzz):**
- `FirebreakMandate.sol` — the Mandate: register with terms + reserve, `rescue(user, plan)` gated on HF-trigger + spend-cap + action-whitelist, flash-rescue callback pattern, non-custodial.
- `MiniLend.sol` — a lending pool exposing a clean `IPosition` adapter (native-USDC debt, WAD health factor), so the keeper is protocol-agnostic — MiniLend is just the first adapter.
- `MiniSwap.sol` (constant-product AMM), `MockOracle.sol`, `MockERC20.sol` (mEURC / mTBILL) round out a full drift scenario.

**Keeper agent — done (TypeScript + viem + Anthropic SDK):**
- `monitor` reads the full health snapshot off-chain (HF, debt, per-token collateral, oracle prices, live swap quotes) — every input is a real on-chain read.
- `strategist` = deterministic sizing core (8/8 sizing tests) + Claude ranker (11/11 harness tests proving the safety contract: valid picks honored, out-of-set picks and API failures fall back to cheapest).
- `executor` sends the chosen plan on-chain and re-checks the spend cap off-chain before spending gas (the off-chain half of a double guard).

**Live on Arc testnet (chainId 5042002) — a real LLM-driven rescue, verified in-window:**
The full scenario is deployed and the keeper executed an end-to-end rescue with Claude in the loop:
- Alice: 10 mEURC collateral, 5 USDC debt. EURC drifted 1.08 → 0.70, pushing HF to **1.120** (below the 1.20 trigger).
- Claude ranked 3 viable paths (TOP-UP 0.94 USDC / ROTATE / DELEVERAGE) and chose **TOP-UP** — zero-cost, no swap, no slippage, full position intact — with a written memo.
- Executor sent it on-chain: **HF 1.120 → 1.380**, spent **0.94 USDC**.
- Tx: https://testnet.arcscan.app/tx/0x6041d281b4d37ae7e599787478e6edb008cc6606a9b7483dd37503105d4d9869
- Independently verified: receipt `success`, and a separate `cast call` confirms Alice's on-chain HF is now `1.38`.
- Evidence file: `agent/evidence/run-testnet-001.json`

**Deployed contracts (Arc testnet):**
- Mandate: https://testnet.arcscan.app/address/0x529D2257dc8BEEA14D02FBc6123a079C08596915
- Pool (MiniLend): https://testnet.arcscan.app/address/0x8B526D995132dB3F55299A4e19045FE1aC3E49a3
- AMM (MiniSwap): `0x3d19c2C9FfFC03A27bE00D32b280e9c219fD0DFe`
- Oracle: `0x5E7d6D15Be0b53845c334BeBF4d72CCEc456a8C8`
- mEURC: `0x27779e2E363Fd5d7CBF0e0C6B1641c0d9b68F7d6` · mTBILL: `0x82f1C6108760855CF83EBA178a751dBEF3a6DFA5`

**Reproducible:** `npm run demo` runs the whole loop (Claude ranks → executor executes → HF restored) against a local anvil deploy; the same code drives testnet by pointing `RPC`/`CHAIN_ID` at Arc. Two local-anvil evidence files (`run-local-001` deterministic, `run-local-002` LLM-driven) accompany the testnet run.

**Dashboard — live console:** `npm run demo:server` boots anvil + the scenario + a thin SSE server; the single-screen page (`agent/app/index.html`) shows the health factor drift past the trigger and the keeper rescue it live (Claude's memo streamed in), with a permanent strip anchoring the real Arc-testnet rescue. A hosted, backendless replay of that testnet rescue is public at https://firebreak-site-wanggang22s-projects.vercel.app.

## Products used (Circle / Arc)

Native USDC as the gas + settlement token (`pay{value}`, 18-decimal), Arc smart contracts + sub-second finality (the rescue lands before the liquidator), Arc testnet RPC + arcscan for verification, and Anthropic Claude as the ranking strategist.

## Next (toward CP3 / final, 8/9)

- **Dashboard + demo video** — a borrower-facing console: sign a Mandate, watch health drift, watch the keeper rescue in real time with Claude's memo.
- **Circle Wallets (User-Controlled)** onboarding — sign a Mandate with email/PIN, no seed phrase (integration path already proven on ARC-TESTNET in a sibling project).
- **More adapters** — the keeper speaks `IPosition`; wiring a second real lending protocol proves the protocol-agnostic claim.
- **Keeper economics** — the keeper pays gas in the same USDC unit as the savings; surface the per-rescue P&L.

---

### Repo

https://github.com/wanggang22/firebreak — `contracts/` (Foundry) · `agent/` (keeper) · `agent/evidence/` (every real rescue, receipts + memos) · `docs/DESIGN.md` + `docs/PLAN.md`.
