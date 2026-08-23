# Jungian Dialogue World

This folder owns the finite dream mechanics, public observation surface,
sidecar controller, evidence encoding, and exact replay adapter inputs.

- The dream is exposed as numeric observation components through
  `sense:dream`; the analyst must read it from the live world.
- Authenticated reads may change decision/read-ledger state but never count as
  strategic actions. Accepted-action evidence remains empty and explicit.
- The controller advances exactly twelve one-second ticks and must cancel its
  pending timer when closed.
- Write all expected evidence before publishing the terminal signal.

