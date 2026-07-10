export const systemViewTopLevelKeys = [
  "simfile_version",
  "name",
  "spawnfile",
  "clock",
  "variables",
  "generators",
  "rules",
  "ledger",
  "telemetry",
  "markers",
  "probes"
] as const;

export const coveragePrimitives = [
  "clock",
  "variables",
  "generators",
  "rules",
  "ledger",
  "telemetry",
  "markers/probes"
] as const;

export type TopLevelKey = typeof systemViewTopLevelKeys[number];
export type CoveragePrimitive = typeof coveragePrimitives[number];

export type CoverageStatus =
  | "implemented"
  | "deferred"
  | `planned:B${number}`;

export type CoverageSubject =
  | { kind: "top-level"; key: TopLevelKey }
  | { kind: "primitive"; primitive: CoveragePrimitive };

export interface CoverageRow {
  subject: CoverageSubject;
  claim: string;
  specRef: string;
  status: CoverageStatus;
  evidence: string;
}

export const matrix: CoverageRow[] = [
  // Frozen top-level rows.
  {
    subject: { kind: "top-level", key: "simfile_version" },
    claim: 'Top-level `simfile_version` is structurally validated as `"0.1"`.',
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/model.ts"
  },
  {
    subject: { kind: "top-level", key: "name" },
    claim: "Top-level `name` is structurally validated as a Simfile identifier.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/parse.test.ts"
  },
  {
    subject: { kind: "top-level", key: "spawnfile" },
    claim: "Top-level `spawnfile` is parsed as an optional source pointer.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/model.ts"
  },
  {
    subject: { kind: "top-level", key: "clock" },
    claim: "Top-level `clock` is structurally parsed and required.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/parse.test.ts"
  },
  {
    subject: { kind: "top-level", key: "variables" },
    claim: "Top-level `variables` is structurally parsed as an id-keyed map.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/parse.test.ts"
  },
  {
    subject: { kind: "top-level", key: "generators" },
    claim: "Top-level `generators` is structurally parsed as an id-keyed map.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/parse.test.ts"
  },
  {
    subject: { kind: "top-level", key: "rules" },
    claim: "Top-level `rules` is structurally parsed as an id-keyed map.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/parse.test.ts"
  },
  {
    subject: { kind: "top-level", key: "ledger" },
    claim: "Top-level `ledger` storage configuration is structurally parsed.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/schema/parse.test.ts"
  },
  {
    subject: { kind: "top-level", key: "telemetry" },
    claim: "Top-level `telemetry` snapshot configuration is structurally parsed.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/runtime/run-record.test.ts"
  },
  {
    subject: { kind: "top-level", key: "markers" },
    claim: "Top-level `markers` is parsed and evaluated against trace events.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/ledger/markers.test.ts"
  },
  {
    subject: { kind: "top-level", key: "probes" },
    claim: "Top-level `probes` is parsed and evaluated against trace artifacts.",
    specRef: "SYSTEMS_VIEW.md#every-top-level-key",
    status: "implemented",
    evidence: "src/report/probes.test.ts"
  },
  // Frozen primitive rows.
  {
    subject: { kind: "primitive", primitive: "clock" },
    claim: "Clock duration, simulated time, phases, and tick resolution execute deterministically.",
    specRef: "DESIGN.md#clock",
    status: "implemented",
    evidence: "src/runtime/trace.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "variables" },
    claim: "Driven and derived numeric variables execute with range clamping.",
    specRef: "DESIGN.md#variables",
    status: "implemented",
    evidence: "src/runtime/trace.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "variables" },
    claim: "Measured and instrument-fed variables execute at tick boundaries.",
    specRef: "DESIGN.md#variables",
    status: "deferred",
    evidence: "src/runtime/trace-compile.ts"
  },
  {
    subject: { kind: "primitive", primitive: "generators" },
    claim: "Deterministic and seeded stochastic generators execute reproducibly.",
    specRef: "DESIGN.md#generators",
    status: "implemented",
    evidence: "src/runtime/trace.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "rules" },
    claim: "Conditions, crossing modes, variable effects, speech, DM, and wake actions execute.",
    specRef: "DESIGN.md#rules",
    status: "implemented",
    evidence: "src/runtime/trace.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "ledger" },
    claim: "Canonical event envelopes and byte-identical JSONL exports are implemented.",
    specRef: "DESIGN.md#events-and-ledger",
    status: "implemented",
    evidence: "src/runtime/run-record.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "ledger" },
    claim: "SQLite and PostgreSQL ledger persistence are available as runtime backends.",
    specRef: "SYSTEMS_VIEW.md#ledger",
    status: "deferred",
    evidence: "src/runtime/run-record.ts"
  },
  {
    subject: { kind: "primitive", primitive: "telemetry" },
    claim: "Snapshot cadence produces a deterministic telemetry artifact.",
    specRef: "SYSTEMS_VIEW.md#telemetry--markers",
    status: "implemented",
    evidence: "src/runtime/run-record.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "markers/probes" },
    claim: "Containment and propagation marker scanning and verdicts are implemented.",
    specRef: "SYSTEMS_VIEW.md#telemetry--markers",
    status: "implemented",
    evidence: "src/ledger/markers.test.ts"
  },
  {
    subject: { kind: "primitive", primitive: "markers/probes" },
    claim: "Probe expectations and bounded `after` plus `within` evaluation are implemented.",
    specRef: "DESIGN.md#probes",
    status: "implemented",
    evidence: "src/report/probes.test.ts"
  }
];
