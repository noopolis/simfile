# Runtime

This folder contains deterministic Simfile runtime helpers.

- `clock.ts` resolves tick, simulated time, and phases.
- `condition.ts` evaluates the shared `when:` condition tree.
- `expression.ts` evaluates the closed arithmetic `eq` subset.
- `trace-compile.ts` prepares runtime state from a parsed Simfile.
- `trace-run.ts` executes a bounded deterministic trace.
- `run-record.ts` writes sealed run-record artifacts.
- `trace.ts` is the folder barrel.

Runtime modules must stay independent from Spawnfile internals and browser UI code.
They may produce public artifacts for the viewer, but they must not add Simfile
authoring surface for presentation concerns.
