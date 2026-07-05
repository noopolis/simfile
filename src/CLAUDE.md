# Simfile Source

This package defines the Simfile schema and CLI.

## Structure

- `schema/` contains the Zod schema, parser, and semantic validation helpers.
- `cli/` contains the thin `simfile` command wrapper.
- `index.ts` is the public package barrel.

## Rules

- Keep simulation semantics declarative. Do not add runtime orchestration here.
- Named exports only.
- Keep tests co-located with the module they cover.
- Avoid importing Spawnfile internals. Simfile can reference Spawnfile ids as strings.
