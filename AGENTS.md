# Simfile Working Guide

This standalone repository is the reference implementation of the Simfile
v0.1 world mechanics package. Spawnfile may be installed as a separate tool or
checked out anywhere; never infer a sibling repository or import its source.

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
└── src/                   # Schema, dynamics, CLI, and runtime-neutral modules
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
- Source-development tool setup belongs under ignored `.simfile-dev/` state and
  must require an explicit package coordinate or absolute checkout path.
- `simfile run` may compose a linked Spawnfile lifecycle only through documented
  CLI operations and versioned receipts. Lifecycle composition never selects,
  wakes, invokes, polls, or waits for agent cognition.
- Keep `src/run/` as the timer-free local deterministic writer. Generic composed
  lifecycle code belongs in its own implementation folder and must be reused by
  any future `simfile dev` watch/debug wrapper.
