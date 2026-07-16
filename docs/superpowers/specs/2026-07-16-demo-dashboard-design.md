# Firebreak Demo Dashboard — Design

**Date:** 2026-07-16
**Goal:** A judge-facing, single-screen live dashboard that tells Firebreak's story in one view: watch Alice's health factor drift toward the liquidation line, then watch the autonomous keeper — with Claude ranking the vetted rescue paths — fix it before liquidators can move. The live run executes on a local anvil (real EVM, real Claude, real tx); a permanent strip anchors credibility to the real Arc testnet rescue already on-chain.

**Non-goals:** No wallet connection, no Circle login, no user-signed Mandate. This is a demo of the product's autonomy, not a self-serve console. (Those are post-hackathon / CP3+ roadmap.)

---

## Architecture

```
Browser  (agent/app/index.html — single self-contained file, inline CSS/JS, no build)
   │  GET /api/state · POST /api/drift · POST /api/reset · SSE /api/rescue
   ▼
HTTP server  (agent/src/server.ts — Node http, no framework; models letta/server.ts)
   │  reuses monitor.readSignals / readTerms, strategist.computeCandidates / decideWith,
   │  executor.executeRescue, llm.makeClaudeRanker  (no decision logic duplicated)
   ▼
Local anvil + DemoSetup scenario  (real EVM · real Claude ranking · real rescue tx)
```

The live rescue is real, just on a **local devnet**. The dashboard labels it truthfully as `Local devnet (live)`. The **Arc testnet** rescue (already executed, tx `0x6041…9869`) is shown in a separate, clearly-labeled `Arc testnet (verified)` strip with arcscan links. The two are never conflated.

## Backend — `agent/src/server.ts`

A thin Node `http` server (no Express), mirroring the pattern in `arcpay/letta/server.ts`. Loads `deployments/local.json`, `ANTHROPIC_API_KEY` from env, keeper key from env. Endpoints:

- `GET /` → serve `app/index.html`.
- `GET /api/state` → `{ position, mandate, hf, trigger, target, phase }` where `phase ∈ {healthy, at_risk, rescuing, rescued}`. Reads live via `readSignals`/`readTerms`.
- `POST /api/drift` → apply the FX drift on-chain (`oracle.setPrice(mEURC, 0.70e18)`), pushing HF below the trigger. Returns the new HF. This is the only manual nudge; the keeper reacts on its own after it.
- `SSE /api/rescue` → run ONE keeper tick with the Claude ranker, streaming a named event per stage:
  - `monitor` `{ hf, trigger, debt }`
  - `candidates` `{ target, viable: [{action, why, costUsdc}] }`
  - `llm` `{ chosenAction, memo, reason }`
  - `executor` `{ txHash, spent }`
  - `restored` `{ hfBefore, hfAfter }`
  - `error` `{ message }` (any stage failure; the decision layer already falls back to the deterministic cheapest path, so `error` is reserved for infra failures, not LLM failures)
- `POST /api/reset` → redeploy a fresh DemoSetup scenario (spawn/replace anvil state) so the demo is repeatable.

**Autonomy loop:** after `/api/drift`, the server's keeper poll loop (every ~2s) detects `hf < trigger` and fires the rescue automatically, emitting the same SSE stream to any connected `/api/rescue` listener. A manual `force` query param on `/api/rescue` triggers immediately as a live-demo backup. This keeps the story honest: the keeper *discovers and acts*, the operator doesn't click "rescue".

**Streaming without duplicating logic:** add an optional `onStage?: (stage: string, data: unknown) => void` callback to `keeper.tick`. `tick` already walks monitor → strategist → executor; it calls `onStage` at each boundary. CLI passes nothing (unchanged behavior); the server passes an emitter that writes SSE frames. One code path, DRY.

## Frontend — `agent/app/index.html`

Single self-contained file. Regions:

- **Header:** `■ FIREBREAK` wordmark + tagline "the line the fire can't cross"; right-aligned `Arc testnet ↗` badge linking the arcscan tx.
- **Left column:**
  - *Position* card: mEURC collateral (amount + USD value at current oracle price), debt in USDC.
  - *Mandate* card: trigger, spend cap, allowed actions (DELEVERAGE·ROTATE·TOP-UP chips), reserve.
- **Center — Health Factor instrument:** a vertical bar/arc gauge with machined tick marks. The **trigger line (1.20)** is drawn as the amber "firebreak" line; the **target (1.38)** as a faint teal line. The HF value drifts down across the amber line on `/api/drift`, then snaps back above it on `restored`. Status pill: `Healthy → At risk → Rescuing → Rescued`.
- **Right/bottom — Keeper log:** keeper events stream in as monospace stdout-style lines/cards as SSE arrives: monitor read, then a **candidate table** (3 paths × cost), then a highlighted **Claude memo card** (the reasoning), then a **tx card**. Live tx labeled `local devnet`.
- **Controls:** `Apply FX drift` (primary), `Reset scenario` (secondary). No "rescue" button — the keeper acts on its own.
- **Testnet proof strip (folded C):** a permanent panel "The same keeper, proven on Arc testnet" — HF 1.120→1.380, 0.94 USDC, arcscan **tx** link, arcscan **Mandate** link, and Claude's actual testnet memo quoted. Sourced from `evidence/run-testnet-001.json`.

### Visual system — "risk-ops terminal" (dark)

Anti-slop, committed to a single dark look (this is a focused demo, not a theme-switching app):

- **Canvas:** zinc-950 (`#09090b`), never pure black. Panels one step lighter (`#111113`), hairline borders `#26262b`.
- **Type:** Geist Mono (or IBM Plex Mono) for all data + logs, `font-variant-numeric: tabular-nums`; a grotesk (Geist Sans) for the few prose labels. No Inter.
- **Accent:** a single ember/amber (`#f59e0b`→`#f97316`) for the trigger line, "at risk", and danger; a cool teal/green (`#2dd4bf`) for restored health and success. No purple neon, no rainbow.
- **Motion:** `transform` + `opacity` only. HF gauge animates via `transform: scaleY`/translate; log cards fade+rise in on arrival; the trigger-cross flashes the amber line once. No `top/left/width/height` animation, no backdrop-blur on scroll containers.
- **Layout:** asymmetric — left rail (position/mandate) narrower than the center instrument; log occupies the right/bottom. Not three equal cards.
- **Icons:** Phosphor (thin, precise) or inline SVG only; no emoji icons.

## Error handling

- Missing `ANTHROPIC_API_KEY` → decision layer already falls back to deterministic cheapest; the `llm` SSE event carries a `fallback: true` flag and the memo notes "deterministic (LLM key not set)". The UI shows a small "deterministic mode" badge instead of failing.
- anvil down / deployment stale → `/api/state` returns `503 { error }`; the UI shows a clear "devnet not running — run `npm run demo:server`" banner rather than a blank page.
- SSE `error` frame → the log shows the failure and the gauge stays at its last known state; `Reset scenario` recovers.

## Testing

- **Backend smoke** (`agent/src/server.smoke.ts` or a shell script): boot anvil + DemoSetup → `GET /api/state` (assert healthy, HF > trigger) → `POST /api/drift` (assert HF < trigger) → consume `/api/rescue?force=1` (assert stages arrive in order and `restored.hfAfter > trigger`) → `POST /api/reset` (assert back to healthy). Exit non-zero on any mismatch.
- Decision correctness is already covered by the existing `strategist` (8/8) and `strategist-llm` (11/11) suites — the server reuses that code, so no new decision tests.
- Manual: load the page, click through drift → auto-rescue, verify the memo + tx render and the testnet strip links resolve on arcscan.

## Files

- Create: `agent/src/server.ts` (HTTP + SSE server)
- Create: `agent/app/index.html` (single-file dashboard)
- Modify: `agent/src/keeper.ts` (add optional `onStage` callback to `tick`)
- Create: `agent/src/server.smoke.ts` (backend smoke test)
- Modify: `agent/package.json` (add `serve` / `demo:server` script)
- Modify: `README.md` (dashboard run instructions; check the "Dashboard + demo video" box's first half)
