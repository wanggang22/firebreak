# Firebreak — Video Design

Codifies the Firebreak product identity (risk-ops terminal) for the demo video.

## Style Prompt

A serious risk-operations terminal, not a marketing splash. Near-black canvas, precise monospace data, hairline borders, generous negative space. The only color is functional: an ember/amber "firebreak line" for danger and the trigger, a cool teal for restored health and safety. Motion is mechanical and exact — instruments moving, not decorations bouncing. It should read like real infrastructure a risk desk would trust, with the drama coming entirely from a health-factor bar drifting across the amber line and snapping back to teal.

## Colors

- `#09090b` — canvas (zinc-950, never pure black)
- `#111113` — panels/cards
- `#26262b` — hairline borders
- `#e4e4e7` — primary ink
- `#8b8b93` — dim/secondary text
- `#f59e0b` / `#f97316` — amber/ember: the firebreak line, trigger, danger, "at risk"
- `#2dd4bf` — teal: restored health, safe, success

## Typography

- **Geist Mono** (fallback: ui-monospace, "SF Mono", Menlo) — all data, numbers (tabular-nums), logs, labels
- **Geist / Geist Sans** (fallback: system-ui) — the few prose headlines
- No Inter, no rounded friendly fonts.

## Motion

- `transform` + `opacity` only. Health-factor bar animates via `scaleY`/translate; cards fade+rise.
- Easing is precise: `power3.out` / `expo.out` for entrances, a firm `power2.in` never used for scene exits (transitions handle exits).
- The trigger-cross is the one dramatic beat: the amber line flashes once as HF drifts below it.
- Numbers count/tick with tabular-nums; no elastic overshoot on data.

## What NOT to Do

- No purple/blue neon gradients, no glow-heavy hero.
- No pure black `#000`; no three equal cards in a row.
- No emoji icons; no Lorem Ipsum; no "Acme/John Doe" placeholders.
- No bouncing/springy motion on financial numbers — it reads untrustworthy.
- No full-screen linear gradients on the dark canvas (H.264 banding) — use solid + localized amber/teal glow.
