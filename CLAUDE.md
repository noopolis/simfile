# Simfile Working Guide

This folder, inside the Spawnfile repository, is the reference implementation
of the Simfile v0.1 world mechanics package.

## Repository Structure

```text
.
├── README.md              # Package overview and quickstart
├── DESIGN.md              # Current product and architecture design
├── VIEW_DESIGN.md         # Viewer (`simfile view`) design: cosmos, portals, lenses
├── package.json           # npm package metadata and CLI scripts
├── tsconfig.json          # Typecheck config
├── tsconfig.build.json    # Build-only emit config
└── src/                   # Schema, CLI, and runtime-neutral modules
```

## Rules

- Keep Simfile aligned with `DESIGN.md`.
- Keep the schema genre-neutral. Domain concepts belong in fixtures, not keys.
- Named exports only.
- Add nested `CLAUDE.md` files for implementation folders.
- Keep source files under 400 lines.
- Keep tests beside the files they cover.
- Keep CLI handlers thin; schema, planning, ledger, and runtime logic belong in modules.
- Do not import Spawnfile internals. Consume explicit machine-readable artifacts.
- Do not add Docker compilation, runtime auth, or deployment ownership here.

