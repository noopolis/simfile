# Simfile Schema

This folder owns the public Simfile v0.1 validation surface.

## Files

- `identifier.ts` owns the shared generic Simfile identifier pattern, schema, and parser helpers.
- `model.ts` defines the structural Zod schema and exported TypeScript types.
- `parse.ts` parses YAML or JSON text into the structural schema.
- `dynamics.test.ts` covers the dynamics-specific schema and pure-validation boundary.
- `semantic.ts` performs cross-field checks such as duplicate ids.
- `index.ts` is the schema barrel.

## Rules

- Structural parsing belongs in `model.ts` and `parse.ts`.
- Cross-record checks belong in `semantic.ts`.
- Do not encode domain-specific worlds here; keep fields generic and composable.
