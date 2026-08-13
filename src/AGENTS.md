# Simfile Source

This package defines the Simfile schema and CLI.

## Structure

- `schema/` contains the Zod schema, parser, and semantic validation helpers.
- `dynamics/` contains the trusted local-module mechanics contract and checked
  host session.
- `cli/` contains the thin `simfile` command wrapper.
- `index.ts` is the public package barrel.

## Rules

- Keep simulation semantics declarative. Lifecycle composition belongs only in
  its dedicated generic layer; do not add agent orchestration anywhere.
- `run/` remains the timer-free local deterministic writer. It must not acquire
  target, organization, service-supervision, or agent-cognition responsibilities.
- Named exports only.
- Keep tests co-located with the module they cover.
- Avoid importing Spawnfile internals. Simfile can reference Spawnfile ids as strings.
