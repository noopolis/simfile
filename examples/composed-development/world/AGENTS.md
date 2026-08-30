# Smoke World

This folder owns the example's deterministic mechanics, checked surface,
finite controller, evidence encoding, and replay implementation.

- The composer imports runtime authority only from emitted
  `./entrypoint.mjs` and `./provider.mjs` modules.
- The host binding imports only public `simfile/*` exports.
- Empty action evidence is intentional. Never synthesize a receipt or action.
- Write the complete expected evidence set before exposing the terminal tick,
  then compare every live step with its deterministic replay expectation.
