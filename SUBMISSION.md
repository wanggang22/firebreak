# Firebreak — The Liquidation Firewall for Stablecoin-Native Lending on Arc

> **Final submission (Checkpoint 3)** · Programmable Money Hackathon (Encode × Arc × Circle)

**Project:** Firebreak — a non-custodial liquidation firewall. Borrowers sign a bounded on-chain **Mandate**; an autonomous keeper agent watches loan health and, before liquidators can move, executes the cheapest bounded rescue in a single atomic transaction.
**Circle account email:** wangligang16161616@gmail.com
**Tracks:** DeFi (primary) + Agentic Economy — it is a DeFi primitive *and* an autonomous agent with money at stake.

| | |
|---|---|
| **Repo** | https://github.com/wanggang22/firebreak |
| **Live demo** | https://firebreak-site-wanggang22s-projects.vercel.app — interactive replay of the real Arc-testnet rescue, with clickable arcscan proof |
| **Video (3 min)** | [`video/renders/firebreak-demo-3min.mp4`](video/renders/firebreak-demo-3min.mp4) |
| **Deck** | [`deck/index.html`](deck/index.html) |
| **Deployed on** | Arc testnet, chainId 5042002 |

---

## Problem

Liquidation is the worst outcome in lending, and on Arc it is usually the *avoidable* one.

On a stablecoin-native L1 your collateral is FX and tokenized RWAs — EURC, T-bills, private credit. These don't gap down 40% in a candle. They **drift**: the euro slides two cents over a week, an RWA re-prices, interest accrues. Health factor walks slowly toward the line while a liquidator bot waits, then takes a **5–10% penalty** out of the borrower's collateral — for something a **0.94 USDC top-up** would have fixed.

Drift is exactly the failure mode automation catches and humans miss. Nobody checks their health factor at 3am. But the usual fixes are both bad: watch it yourself (you won't), or hand a bot your keys (now something else controls your collateral). **Automation you can't bound isn't safety — it's a different risk.**

## What we built

The borrower signs a **Mandate** — a bounded, conditional, non-custodial authorization stored on-chain:

- **Trigger** — act only when health factor < X (e.g. 1.20)
- **Spend cap** — never move more than Y USDC of collateral *value* per rescue (oracle-priced, not a keeper-chosen swap leg)
- **Max slippage** — the swap must recover at least (1 − s) of that value, a floor the *borrower* signs
- **Action whitelist** — any subset of `{ DELEVERAGE, ROTATE, TOP-UP }`

A keeper agent watches the loan and, when health crosses the trigger, executes the **cheapest rescue that fits the Mandate** — one atomic transaction, settled sub-second in native USDC. `FirebreakMandate` re-checks every bound on-chain at execution, so the keeper is untrusted by construction: it never holds borrower funds and cannot exceed the cap, take an un-whitelisted action, or act on a healthy position.

### The agentic core: the LLM ranks, deterministic code sizes and bounds-checks

This is the design decision the project turns on.

The naive approach — hand the position to a model and execute its answer — is how you get a model confidently sizing a swap wrong with real collateral at stake. Financial sizing is arithmetic; "it usually gets it right" is not a safety property.

Instead:

1. **The deterministic core** builds *every* allowed rescue path, sizes each to restore health to target (closed-form), prices it, and drops any that breach the spend cap → a set of **vetted, executable candidates**.
2. **Claude ranks that set, and only that set.** The tool schema is a strict enum of the candidate action ids, so the model cannot name an action that wasn't vetted. It also writes the borrower-facing memo explaining the choice.
3. **Any deviation falls back.** Out-of-set pick, API error, timeout → the cheapest vetted path executes anyway. A rescue is never stalled by the model being down.

The model's only freedom is **which safe path** — never whether it's safe. 11/11 harness tests pin exactly this contract.

## Evidence — everything below is on-chain and verifiable

### 1. A real LLM-driven rescue on Arc testnet

EURC drifted down; health factor hit **1.120**, under the 1.20 trigger. The core sized three viable paths; Claude ranked them and chose TOP-UP; the executor sent it.

| path | cost | detail |
|---|---|---|
| **TOP-UP ✓** | 0.00 USDC | 0.94 USDC from reserve — no swap, no slippage, no collateral sold |
| ROTATE | ~0.00 | 7.00 USDC mEURC (LT .80) → mTBILL (LT .90), two swap legs |
| DELEVERAGE | 0.36 USDC | sell 2.24 USDC of mEURC — permanently smaller position |

**HF 1.120 → 1.380**, spent **0.94 USDC**.
tx [`0x57be…ae74`](https://testnet.arcscan.app/tx/0x57be4221ed1258879fb57a4c8fd378b0a82462424b022408cb46060d3465ae74) · Mandate [`0xf263…3a18`](https://testnet.arcscan.app/address/0xf26397EA0491d958d8f1d12C90DcB371101F3a18) · [evidence](agent/evidence/run-testnet-001.json)
Verified independently: receipt `success`, plus a separate `cast call` confirming on-chain HF is `1.38`.

### 2. The keeper runs on a Circle Agent Wallet (Agent Stack)

The same rescue, with **no raw private key in the loop**. The keeper is a **Circle Agent Wallet** — an ERC-4337 smart contract account provisioned by `circle wallet login` — and the Claude-ranked plan is executed through `circle wallet execute`.

**HF 1.120 → 1.380**, debt 5.000 → 4.058 USDC, network fee 0.0100 USDC.
tx [`0xbdab…0e81`](https://testnet.arcscan.app/tx/0xbdabd54e0a3dcda9d3f8c2c7810700f5e472dcebd585649c879751be6b210e81) · [evidence](agent/evidence/run-testnet-agentwallet.json) · [design + constraints](docs/CIRCLE-AGENT-STACK.md)

The transaction's `to` is the ERC-4337 EntryPoint and `tx.origin` is Circle's bundler; the effective `msg.sender` at `FirebreakMandate` is the agent wallet itself, which is why the Mandate's keeper check passes. **The keeper is an agent operating a smart account under account abstraction** — the shape the Agentic Economy track is about.

Two things we hit and handled honestly:

- **Circle CLI v0.0.6 cannot encode struct arguments.** `rescue(address,(uint8,...))` failed estimation in every encoding tried, while simple-argument calls estimated fine, and `cast` confirmed the call itself was valid. So `FirebreakMandate` exposes `rescueFlat(...)`, delegating to the **identical internal path** — proven equivalent and still keeper-gated by two dedicated tests.
- **Circle wallet spend policies are mainnet-only, and Arc is testnet-only for Agent Wallets.** These don't overlap, so this run demonstrates the keeper *running on* an Agent Wallet — **not** a Circle-enforced spend policy. On Arc the Mandate contract remains the enforcing layer. The Circle policy layer becomes a second, independent bound when both reach mainnet. We state this rather than imply a guardrail we haven't run.

### 3. Where the LLM earns its place — cheapest ≠ best

The obvious objection to an "AI agent" is *"you added an LLM to an if-statement."* Here is the answer, executed on-chain. With a deliberately small reserve, the **cheapest path (a zero-cost TOP-UP) only *partially* restores health** — HF 1.266, still at risk — while **ROTATE fully reaches the 1.380 target for 0.36 USDC**. The deterministic cheapest-by-cost rule would pick the free partial fix and *leave the position in danger*. Claude, seeing each candidate's projected health factor, picks ROTATE and explains why:

> *"ROTATE fully restores health to the 1.380 target for just 0.36 USDC by swapping into higher-quality collateral, keeping your market exposure intact. The TOP-UP only reaches 1.266 (still at risk), and DELEVERAGE costs 17.69 USDC and permanently shrinks your position — neither is warranted when a cheap durable fix exists."*

Executed: **HF 1.190 → 1.602**, the position genuinely rotated into ~59.8 mTBILL (verified on-chain). This is a real judgment the naive rule gets *wrong* — the value the model adds, in one transaction. ([evidence](agent/evidence/run-local-flagship.json), `contracts/script/DemoFlagship.s.sol`; same audited contract as the testnet heroes.)

### 4. Tests and reproducibility

- **Contracts:** 55 Foundry tests green, including fuzz — `FirebreakMandate`, `MiniLend` (IPosition), `MiniSwap`, `MockOracle`, `MockERC20`.
- **Agent:** 8/8 strategist sizing + 11/11 LLM-safety harness (valid picks honored including non-cheapest; out-of-set picks and thrown rankers fall back; below-trigger never calls the model).
- **Local console:** `npm run demo:server` boots anvil + the scenario + an SSE server; the single-screen dashboard streams each keeper stage live (drift → candidates → Claude's memo → tx → restored). End-to-end smoke test covers drift → rescue → reset.
- Every rescue receipt and memo is committed under `agent/evidence/`.

## Why this specifically wants Arc

Three properties, each load-bearing — remove any one and the product stops working:

1. **Collateral that drifts instead of gapping.** FX and tokenized RWAs are Arc's native collateral. Slow drift is what a watching agent catches and a human misses.
2. **Sub-second settlement.** The rescue must land *before* the liquidator's transaction. Rescue and liquidation are in a race; finality latency is the margin.
3. **USDC-denominated gas.** Keeper cost and borrower savings are in the same unit, so "is a 0.94 USDC rescue worth sending?" is a decision you can actually make.

## Products used

Native USDC (gas + settlement, 18-decimal), Arc smart contracts and sub-second finality, Arc testnet RPC + arcscan for verification, **Circle Agent Stack — Agent Wallets** (ERC-4337 smart account as the keeper, `@circle-fin/cli`), and Anthropic Claude (`claude-opus-4-8`) as the ranking strategist.

## Roadmap

- **Circle wallet spend policies** as a second enforced bound, once Arc + Agent Wallets meet on mainnet.
- **Real protocol adapters** — the keeper speaks a small `IPosition` interface; MiniLend is the first adapter, and wiring a live Arc lending venue proves the protocol-agnostic claim.
- **Keeper economics** — a capped per-rescue fee inside the Mandate, designed so it cannot incentivise unnecessary rescues.
- **Agent identity** — authorize a verified agent identity (ERC-8004 / KYA) instead of a raw keeper address, so a borrower can revoke a *class* of keeper rather than one key.
- **Multi-keeper coordination** — first-writer-wins on-chain today; commit-reveal if racing becomes real.

---

**Repo layout:** `contracts/` (Foundry) · `agent/` (keeper: monitor / strategist / executor) · `agent/evidence/` (every real rescue) · `web/` (public replay) · `video/` · `deck/` · `docs/`
