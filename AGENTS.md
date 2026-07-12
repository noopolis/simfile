# Simfile Working Guide

This folder, inside the Spawnfile repository, is the reference implementation
of the Simfile v0.1 world mechanics package.

## Repository Structure

```text
.
├── README.md              # Package overview and quickstart
├── docs/                  # Design and research docs: DESIGN, VIEW_DESIGN,
│                          # VIEW_STYLEGUIDE, SITE_DESIGN, SYSTEMS_VIEW,
│                          # RESEARCH, COVERAGE
├── package.json           # npm package metadata and CLI scripts
├── tsconfig.json          # Typecheck config
├── tsconfig.build.json    # Build-only emit config
└── src/                   # Schema, CLI, and runtime-neutral modules
```

## Rules

- Keep Simfile aligned with `docs/DESIGN.md`.
- Keep the schema genre-neutral. Domain concepts belong in fixtures, not keys.
- Named exports only.
- Add nested `AGENTS.md` files for implementation folders and compatibility `CLAUDE.md` symlinks pointing to them.
- Keep source files under 400 lines.
- Keep tests beside the files they cover.
- Keep CLI handlers thin; schema, planning, ledger, and runtime logic belong in modules.
- Do not import Spawnfile internals. Consume explicit machine-readable artifacts.
- Do not add Docker compilation, runtime auth, or deployment ownership here.
