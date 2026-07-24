# Firebreak — The Liquidation Firewall for Stablecoin-Native Lending on Arc

> **Final submission (Checkpoint 3)** · Programmable Money Hackathon (Encode × Arc × Circle)

**Project:** Firebreak — a non-custodial liquidation firewall. Borrowers sign a bounded on-chain **Mandate**; an autonomous keeper agent watches loan health and, before liquidators can move, executes the cheapest bounded rescue in a single atomic transaction.
**Circle account email:** wangligang16161616@gmail.com
**Tracks:** DeFi (primary) + Agentic Economy — it is a DeFi primitive *and* an autonomous agent with money at stake.

| | |
|---|---|
| **Repo** | https://github.com/wanggang22/firebreak |
| **Live demo** | https://firebreak-site-wanggang22s-projects.vercel.app — interactive replay of the real Arc-testnet rescue, with clickable arcscan proof |
| **Video (3 min)** | https://youtu.be/2gbuq-k4IHo — plays in the browser ([source mp4](video/renders/firebreak-demo-3min.mp4)) |
| **Deck** | https://firebreak-deck.vercel.app — 12 slides, opens in the browser ([source](deck/index.html)) |
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

### 4. The counterfactual — protected vs unprotected twin

Two identical positions (100 mEURC collateral, 50 USDC debt) drift toward liquidation; one signs a Firebreak Mandate, one doesn't. Executed on-chain:

- **Unprotected twin:** rode the drift to HF 0.77 and was **liquidated — all 100 mEURC seized** to cover the 50 USDC debt at the crashed price (110% penalty). The whole leveraged position, gone.
- **Firebreak:** the keeper deleveraged *early* at the 1.20 trigger (sold 17 mEURC), and through the same drift the position stayed solvent — **kept 83 of 100 mEURC**, HF 1.008, never liquidated.

Same market, opposite outcomes. The firewall acts early precisely so you never reach the liquidation line — which is also the honest answer to *"why rescue at 1.20 not 1.0?"* ([evidence](agent/evidence/run-local-twin.json), `contracts/script/DemoTwin.s.sol`).

### 5. Protocol-agnostic — falsified, not asserted

Every integration claims to be protocol-agnostic. With only MiniLend behind `IPosition` ours was self-certified: one adapter, written by us, shaped like our own interface.

So we wrote a second pool designed to break it. **`ScaledLend` shares no accounting with MiniLend**: collateral is held as *shares* redeemable at a growing exchange rate, and debt is stored *scaled* against a borrow index that accrues every second — how Aave and Compound actually work, and the case that breaks naive integrations. A keeper assuming `collateralOf` returns a stored number, or that debt only moves when someone transacts, sizes the rescue wrong here.

**The same `FirebreakMandate` bytecode and the same unmodified keeper guard both pools.** (`test_SameMandateRescuesADifferentProtocol`, `test_DeleverageOnScaledCollateral`.)

It also exposes a risk MiniLend cannot express. In MiniLend, health only falls when the oracle moves — a drift that may never come. Here the index rises every second, so **health decays with the market perfectly still**. `test_HealthDecaysWithAStillMarket` pins it: identical price before and after, lower health factor. That is not a possibility to hedge against; it is arithmetic, and it is the purest form of the slow slide Firebreak exists to catch.

### 6. Keeper economics — a fee that cannot reward unnecessary rescues

An autonomous agent that costs money to run has to be paid, but a careless fee turns the keeper against the borrower it guards. The shape matters more than the number.

The fee is **flat and fixed at signing**, not a share of what was moved. A percentage would pay more for larger rescues and quietly reward taking the most expensive viable path; flat leaves the keeper indifferent to size, so choosing the cheapest path that works costs it nothing.

It also cannot farm frequency: a rescue is reachable only below the borrower's trigger and must lift health by `minImprovement` — which pushes the position back out of the band it would have to re-enter to bill again. **Keeper revenue tracks how often the market actually threatens the position, not anything the keeper decides.**

Paid last, after every bound has passed, so it is payment for a repaired position rather than a retainer. An underfunded reserve costs the keeper its fee and never costs the borrower the rescue (`test_KeeperFee_ShortReserveStillRescues`). A borrower may set it to zero and run an unpaid keeper.

### 7. What our own audit found

We reviewed the code added late in the build rather than assuming it was fine, and it was not.

`ScaledLend.setExchangeRate` shipped **without an owner check**. Raising that rate raises every holder's collateral value, and with it their health factor and borrowing power — an open setter is a mint-collateral-from-nothing button. `listCollateral` and `setRate` were exposed the same way. MiniLend had the owner guard from the start; the second adapter was written against its structure and the guard did not come along.

Fixed, and pinned by four tests that attempt the attack from a stranger address (`test_RevertWhen_StrangerRaisesExchangeRate` asserts the health factor is unchanged by the attempt). `fund()` stays deliberately open — paying into a pool harms nobody.

The same pass caught a `Terms` literal in `DemoSetup.s.sol` that never got the new `keeperFee` field. It compiled from cache and surfaced only on a clean rebuild, which is exactly the kind of thing that would have broken a fresh clone.

Continuing into the keeper's own code found two more, both on the path that moves money:

- **The refill amount was rendered with `Number()`.** Circle's SDK takes the amount as a decimal string, and `Number(bigint)/1e18` drops the low digits of an 18-decimal value (`1.234567890123456789` became `1.2345678901234567`) and prints small amounts in exponent form (`1e-9`), which is not a decimal number at all. Either one sends the wrong amount, or none. Now `formatEther`, pinned by 8 tests asserting every amount renders exactly and reparses to itself.
- **A mis-ordered refill policy produced a negative amount.** With `target` at or below `floor`, the gap subtraction went negative and bigint carried the sign silently downstream. Now clamped, with a test sweeping policies and inputs to assert no field ever goes negative.

Neither was reachable in the happy path, which is why tests written from the happy path missed them.

We would rather show the defect and the fix than present a clean sheet.

### 8. Tests and reproducibility

- **Contracts:** 75 Foundry tests green, including fuzz — `FirebreakMandate`, `MiniLend` + `ScaledLend` (two independent `IPosition` adapters), `MiniSwap`, `MockOracle`, `MockERC20`.
- **Agent:** 10/10 strategist sizing + 11/11 LLM-safety harness (valid picks honored including non-cheapest; out-of-set picks and thrown rankers fall back; below-trigger never calls the model) + 16/16 reserve-refill policy + 8/8 amount rendering.
- **Local console:** `npm run demo:server` boots anvil + the scenario + an SSE server; the single-screen dashboard streams each keeper stage live (drift → candidates → Claude's memo → tx → restored). End-to-end smoke test covers drift → rescue → reset.
- Every rescue receipt and memo is committed under `agent/evidence/`.

## Why this specifically wants Arc

Three properties, each load-bearing — remove any one and the product stops working:

1. **Collateral that drifts instead of gapping.** FX and tokenized RWAs are Arc's native collateral. Slow drift is what a watching agent catches and a human misses.
2. **Sub-second settlement.** The rescue must land *before* the liquidator's transaction. Rescue and liquidation are in a race; finality latency is the margin.
3. **USDC-denominated gas.** Keeper cost and borrower savings are in the same unit, so "is a 0.94 USDC rescue worth sending?" is a decision you can actually make.

## Products used

Native USDC (gas + settlement, 18-decimal), Arc smart contracts and sub-second finality, Arc testnet RPC + arcscan for verification, **Circle Agent Stack — Agent Wallets** (ERC-4337 smart account as the keeper, `@circle-fin/cli`), and Anthropic Claude (`claude-opus-4-8`) as the ranking strategist.

### App Kits — Unified Balance, as the borrower's cross-chain reserve

The rescue itself is a collateral swap inside one position on one chain, and it stays atomic. But the **reserve** that funds the cheapest rescue path has no reason to live on Arc.

TOP-UP repays debt from a reserve the borrower prepays into the Mandate. That forces a borrower to park idle USDC on Arc for months against a liquidation that may never come — and when the reserve runs thin, the cheapest path silently stops being available. This is not hypothetical: on our live testnet Mandate the reserve is **0.06 USDC**, which is exactly why the flagship run's TOP-UP could only reach HF 1.266 instead of the 1.380 target.

So the reserve lives in the borrower's **Circle Unified Balance** (`@circle-fin/unified-balance-kit`), spread across any chain they already hold USDC on, and the keeper refills the Arc-side reserve when it drops below a floor. Crossing chains cannot be atomic, so this is deliberately a **second keeper loop** — it keeps the magazine loaded *before* the shot is needed, and never runs inside a rescue.

The authorization shape is the one Firebreak already uses:

| layer | borrower grants | keeper may |
|---|---|---|
| Arc | `register(Terms)` | move collateral, within trigger/cap/whitelist |
| Circle | `addDelegate(USDC, keeper)` | spend unified balance, within the delegate bound |

The borrower owns both sides and either revocation alone stops the keeper. `topUpReserveFor(address)` is permissionless by design — funds land under the *borrower's* mandate, withdrawable only by them, spendable by the keeper only through the same bounded `rescue` path, so paying in grants the payer nothing (pinned by `test_TopUpReserveFor_GivesPayerNoControl`).

Verified live against Circle Gateway, not mocked: Arc Testnet is confirmed supported at chainId 5042002, with 12 testnets usable as reserve sources. Run `npm run reserve -- <borrower>` for the ammunition report.

**Send / Bridge / Swap are not used.** They solve cross-chain payment and liquidity movement; Firebreak's remaining money movement is the atomic on-chain swap leg, and routing that through an external SDK would break atomicity without changing what the product does. We'd rather name the one App Kit that genuinely fits than bolt on three for the checklist.

## Roadmap

- **Circle wallet spend policies** as a second enforced bound, once Arc + Agent Wallets meet on mainnet.
- **A live Arc lending venue.** Two independent adapters (`MiniLend`, `ScaledLend`) now show the `IPosition` abstraction survives genuinely different accounting; the remaining step is a third adapter against a deployed third-party pool, which is integration work rather than design risk.
- **Cross-chain refill, end to end.** The Unified Balance integration is verified live against Circle Gateway and the refill policy is tested, but we have not yet executed a funded `deposit → addDelegate → spend` on testnet. We would rather say that than show a screenshot of a flow we have not run.
- **Agent identity** — authorize a verified agent identity (ERC-8004 / KYA) instead of a raw keeper address, so a borrower can revoke a *class* of keeper rather than one key.
- **Multi-keeper coordination** — first-writer-wins on-chain today; commit-reveal if racing becomes real.

---

**Repo layout:** `contracts/` (Foundry) · `agent/` (keeper: monitor / strategist / executor) · `agent/evidence/` (every real rescue) · `web/` (public replay) · `video/` · `deck/` · `docs/`
