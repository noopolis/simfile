# Simfile Coverage

> Generated from `src/coverage/matrix.ts`. Run `npm run coverage:render` after changing the manifest.

This matrix uses the seven audit buckets requested by B40. In `DESIGN.md`, telemetry and markers are configuration, probes are a primitive, and entity lifecycle is the dormant seventh design primitive.

| Subject | Claim | Spec | Status | Evidence |
|---|---|---|---|---|
| top-level · `simfile_version` | Top-level `simfile_version` is structurally validated as `"0.1"`. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/model.ts` |
| top-level · `name` | Top-level `name` is structurally validated as a Simfile identifier. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/parse.test.ts` |
| top-level · `spawnfile` | Top-level `spawnfile` is parsed as an optional source pointer. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/model.ts` |
| top-level · `clock` | Top-level `clock` is structurally parsed and required. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/parse.test.ts` |
| top-level · `variables` | Top-level `variables` is structurally parsed as an id-keyed map. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/parse.test.ts` |
| top-level · `generators` | Top-level `generators` is structurally parsed as an id-keyed map. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/parse.test.ts` |
| top-level · `rules` | Top-level `rules` is structurally parsed as an id-keyed map. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/parse.test.ts` |
| top-level · `ledger` | Top-level `ledger` storage configuration is structurally parsed. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/schema/parse.test.ts` |
| top-level · `telemetry` | Top-level `telemetry` snapshot configuration is structurally parsed. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/runtime/run-record.test.ts` |
| top-level · `markers` | Top-level `markers` is parsed and evaluated against trace events. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/ledger/markers.test.ts` |
| top-level · `probes` | Top-level `probes` is parsed and evaluated against trace artifacts. | `SYSTEMS_VIEW.md#every-top-level-key` | `implemented` | `src/report/probes.test.ts` |
| primitive · `clock` | Clock duration, simulated time, phases, and tick resolution execute deterministically. | `DESIGN.md#clock` | `implemented` | `src/runtime/trace.test.ts` |
| primitive · `variables` | Driven and derived numeric variables execute with range clamping. | `DESIGN.md#variables` | `implemented` | `src/runtime/trace.test.ts` |
| primitive · `variables` | Measured and instrument-fed variables execute at tick boundaries. | `DESIGN.md#variables` | `deferred` | `src/runtime/trace-compile.ts` |
| primitive · `generators` | Deterministic and seeded stochastic generators execute reproducibly. | `DESIGN.md#generators` | `implemented` | `src/runtime/trace.test.ts` |
| primitive · `rules` | Conditions, crossing modes, variable effects, speech, DM, and wake actions execute. | `DESIGN.md#rules` | `implemented` | `src/runtime/trace.test.ts` |
| primitive · `ledger` | Canonical event envelopes and byte-identical JSONL exports are implemented. | `DESIGN.md#events-and-ledger` | `implemented` | `src/runtime/run-record.test.ts` |
| primitive · `ledger` | SQLite and PostgreSQL ledger persistence are available as runtime backends. | `SYSTEMS_VIEW.md#ledger` | `deferred` | `src/runtime/run-record.ts` |
| primitive · `telemetry` | Snapshot cadence produces a deterministic telemetry artifact. | `SYSTEMS_VIEW.md#telemetry--markers` | `implemented` | `src/runtime/run-record.test.ts` |
| primitive · `markers/probes` | Containment and propagation marker scanning and verdicts are implemented. | `SYSTEMS_VIEW.md#telemetry--markers` | `implemented` | `src/ledger/markers.test.ts` |
| primitive · `markers/probes` | Probe expectations and bounded `after` plus `within` evaluation are implemented. | `DESIGN.md#probes` | `implemented` | `src/report/probes.test.ts` |
