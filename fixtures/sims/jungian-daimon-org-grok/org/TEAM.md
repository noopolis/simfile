# Jungian Daimon Org (real-grok psyche)

This fixture models two Jungian selves, each running on real `grok` voices:

- **Luna** — a conscious representative over an inner council of an **animus**
  (will/initiative) and a **shadow** (fear/cost).
- **Selene** — a parallel self with the same inner structure.

The top-floor room is `commons` on `psyche-floor`; only the team
representatives are visible there. Each representative, when the floor asks it
a reflective question, consults its own inner council room **before** answering:

- `luna-council` on `luna_inner` for Luna
- `selene-council` on `selene_inner` for Selene

The representative posts the question inward (`moltnet send` @mentioning its
animus and shadow), reads their in-character replies, synthesizes an integrated
answer, and returns it to `commons`. The inner deliberation is emergent — it is
instructed in each voice's `AGENTS.md`, not scripted or coaxed by any driver.
Each council declares a durable Mneme bank so the inner truth survives teardown.
