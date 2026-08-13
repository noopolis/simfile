# World Server Guide

This directory owns transport adapters around the single injected `WorldRuntime`.

- Keep authentication in the shared handler. Derive principals only through the injected bearer resolver; request bodies never select identity.
- Keep JSON and future MCP adapters semantically thin. `act` must always lower through the canonical B23 envelope.
- Bound headers, bodies, nesting, deadlines, and response bytes. Return fixed redacted error codes without diagnostics or request data.
- `/readyz` is a non-agent probe: it must not authenticate, resolve a principal, call the runtime, consume a decision, read mechanics, or wake anything.
- Export unbound request listeners only. Deployment code owns `createServer`, `listen`, socket policy, and shutdown.
- Keep focused tests beside the adapter. Do not run mechanics-bearing or live simulations from this directory.
- Use named exports and keep each production source file under 400 physical lines.
