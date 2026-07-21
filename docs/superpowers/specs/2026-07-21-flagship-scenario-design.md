# Flagship Scenario — "cheapest ≠ best" + twin liquidation

**Date:** 2026-07-21
**Goal:** Close the three product-gap P0s the adversarial review found, with one reusable scenario:
1. **LLM adds visible value** — Claude picks a *non-cheapest* path (ROTATE over a zero-cost TOP-UP) because the cheap one only *partially* restores health. Made honest by the M2 fix (candidates now carry projected HF).
2. **Realistic stakes + counterfactual** — a meaningful-scale position, and an identical *unprotected twin* that gets liquidated, so the screen shows "Firebreak spent $X · liquidation would have cost $Y."
3. **Someone actually signs a Mandate** — the borrower configures trigger/cap/whitelist/reserve and signs `register()` on-chain (roadmap: browser-signed; devnet: server-signed on click).

This spec covers Phase A (the non-cheapest hero) — the highest-leverage slice — and sketches Phases B/C.

## Phase A — the non-cheapest rescue (build now)

### Why cheapest ≠ best here (the math, so it's honest not staged)

A rescue must restore health to the target (1.15 × trigger). A path is only chosen if it *reaches* that target (post-M2). Tune the scenario so the zero-cost TOP-UP **cannot** reach it (reserve too small) while ROTATE **can**:

- Collateral: `mEURC` at **LT 0.70** (drifting FX). Rotate target: `mTBILL` at **LT 0.90** (T-bill). The 0.20 LT gap is what gives ROTATE enough lift.
- Position: 100 mEURC, debt 50 USDC, **reserve 3 USDC** (deliberately small).
- Drift mEURC 1.08 → **0.85**: weighted = 100·0.85·0.70 = 59.5, HF = 1.19 (< 1.20 trigger). Target 1.38.
  - **TOP-UP** needs to repay `V = 50 − 59.5/1.38 ≈ 6.9`; reserve is only 3 → repays 3 → HF ≈ 1.266. **PARTIAL** (< 1.38).
  - **ROTATE** moves value M from LT 0.70 → 0.90: newW = 59.5 + 0.20·M ≥ 69 ⇒ M ≥ 47.5, and held value is 85 ≥ 47.5. **Reaches target.** ✓
  - **DELEVERAGE** viable as a costlier backstop (sells collateral, shrinks the position).

So Claude, seeing each candidate's projected HF, correctly prefers ROTATE — the durable full fix — over the zero-cost partial TOP-UP, and its memo explains the tradeoff. This is a real judgment the deterministic cheapest-by-cost rule gets *wrong*; it is exactly the value the LLM adds, and it's now visible in one tx.

### Deliverable

- `contracts/script/DemoFlagship.s.sol` — same shape as DemoTestnet, tuned params above (LT 0.7/0.9, 100/50/reserve 3, drift → 0.85). Registers the Mandate with `maxSlippageWad` 0.02, `minImprovementWad` 0.02.
- Run the standard keeper against it on Arc testnet → a hero tx where Claude chooses ROTATE. Evidence: `agent/evidence/run-testnet-flagship.json` (with the candidate table showing TOP-UP=PARTIAL, ROTATE=full-fix, and Claude's durability memo).
- This becomes the headline agentic-track proof; the existing TOP-UP hero stays as the "cheapest is genuinely best" case.

## Phase B — twin liquidation + counterfactual (next)

Deploy an identical **unprotected** twin position (no Mandate). The scenario drifts further: the protected position is rescued at the 1.20 trigger; the twin, with no firewall, rides the drift down past **HF < 1.0** and is liquidated via `MiniLend.liquidate()` at the protocol's penalty. Render side by side: "Firebreak: rotated, position intact, spent ~$Xfee · No Firebreak: liquidated, −N% penalty, position gone."

Honest framing (the review's A4): the firewall acts *early* (1.20) precisely so you never reach the liquidation line (1.0); the twin shows what "no firewall" costs. This turns "why rescue at 1.20 not 1.0" from a contradiction into the point.

## Phase C — signable Mandate in the console (next)

A "Sign your Mandate" panel in `agent/app/index.html`: sliders/inputs for trigger, spend cap, whitelist, reserve → `POST /api/register` → the server sends `register()` on the devnet (server-held devnet key today; browser wallet is the mainnet roadmap). The Mandate card then populates from chain. The judge experiences configuring and signing the bounded authorization — the thesis, made tangible.

## Reuse

One scenario, re-skinned everywhere: the deck's proof slide, the 3-min video's rescue scene, the public replay page, and the SUBMISSION evidence table all point at the flagship run instead of (or alongside) the TOP-UP run. Per the review: "one artifact, four P0s closed."
