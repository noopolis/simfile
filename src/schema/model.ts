import { z } from "zod";

const identifierPattern = "[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*";

export const simfileIdentifierSchema = z.string().regex(new RegExp(`^${identifierPattern}$`), {
  message: "expected lowercase identifier with letters, numbers, dashes, or underscores"
});

const simfileDurationSchema = z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:ms|s|m|h|d|w)$/u, {
  message: "expected duration string (e.g. 20s, 1.5m, 2h)"
});

export const simfileRangeSchema = z.string().regex(
  new RegExp(`^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?\\.\\.-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$`),
  { message: "expected range string like 0..1" }
).superRefine((value, context) => {
  const [start, end] = value.split("..");
  if (Number.parseFloat(start) >= Number.parseFloat(end)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "range lower bound must be less than upper bound",
      path: []
    });
  }
});

const scopeAgentPattern = new RegExp(`^agent:${identifierPattern}$`);
const scopeTeamPattern = new RegExp(`^team:${identifierPattern}$`);
const scopeRoomPattern = new RegExp(`^room:${identifierPattern}:${identifierPattern}$`);
const scopePairPattern = new RegExp(`^pair:${identifierPattern}:${identifierPattern}$`);
const simfileRoomScopeSchema = z.string().regex(scopeRoomPattern, {
  message: "expected room scope (room:<network>:<room>)"
});
const simfileAgentScopeSchema = z.string().regex(scopeAgentPattern, {
  message: "expected agent scope (agent:<id>)"
});

const simfileScopeSchema = z.string().refine((value) => {
  return value === "global"
    || scopeAgentPattern.test(value)
    || scopeTeamPattern.test(value)
    || scopeRoomPattern.test(value)
    || scopePairPattern.test(value);
}, {
  message: "expected scope string global | agent:<id> | room:<network>:<room> | team:<id> | pair:<a>:<b>"
});

export const simfileEventKinds = [
  "clock.sync",
  "rule.fired",
  "world.message",
  "world.dm",
  "world.act",
  "wake.recommended",
  "marker.seen"
] as const;

const simfileEventKindSchema = z.enum(simfileEventKinds);

const simfileWhenLeafSchema = z.union([
  z.object({
    variable: simfileIdentifierSchema,
    above: z.number().optional(),
    below: z.number().optional(),
    for: simfileDurationSchema.optional()
  }).strict().refine((value) => value.above !== undefined || value.below !== undefined, {
    message: "variable condition requires above and/or below"
  }),
  z.object({
    phase: simfileIdentifierSchema
  }).strict(),
  z.object({
    event: simfileEventKindSchema,
    target: z.string().optional(),
    actor: z.string().optional(),
    scope: simfileScopeSchema.optional()
  }).strict()
]);

export const simfileWhenSchema: z.ZodTypeAny = z.lazy(() => z.union([
  simfileWhenLeafSchema,
  z.object({
    all: z.array(simfileWhenSchema).min(1)
  }).strict(),
  z.object({
    any: z.array(simfileWhenSchema).min(1)
  }).strict(),
  z.object({
    not: simfileWhenSchema
  }).strict()
]));

export const simfileClockSchema = z.object({
  seed: z.string().min(1),
  tick: simfileDurationSchema,
  sim_per_tick: simfileDurationSchema.optional(),
  phases: z.record(simfileIdentifierSchema, z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)).default({})
}).strict();

const simfileMeasureSchema = z.object({
  kind: z.enum(["messages_in", "token_mentions", "marker_violations", "distinct_speakers", "mentions_of", "ticks_since_last_message"]),
  scope: simfileScopeSchema.optional(),
  window: simfileDurationSchema
}).strict();

const simfileDerivedSchema = z.object({
  eq: z.string().min(1)
}).strict();

const simfileVariableSchema = z.object({
  scope: simfileScopeSchema,
  initial: z.number().optional(),
  range: simfileRangeSchema,
  measure: simfileMeasureSchema.optional(),
  derive: simfileDerivedSchema.optional(),
  fed_by: simfileIdentifierSchema.optional()
}).refine((value) => {
  const sourceCount = Number(value.measure !== undefined) + Number(value.derive !== undefined) + Number(value.fed_by !== undefined);
  return sourceCount <= 1;
}, {
  message: "variables must use at most one of measure, derive, or fed_by"
}).strict();

const simfileGeneratorDeterministicSchema = z.object({
  kind: z.literal("deterministic"),
  when: simfileWhenSchema.optional(),
  variable: simfileIdentifierSchema,
  delta: z.number().optional(),
  delta_eq: z.string().optional(),
  set_eq: z.string().optional()
}).refine((value) => {
  const writerCount = Number(value.delta !== undefined) + Number(value.delta_eq !== undefined) + Number(value.set_eq !== undefined);
  return writerCount === 1;
}, {
  message: "deterministic generators require exactly one of delta, delta_eq, or set_eq"
}).strict();

const simfileGeneratorStochasticSchema = z.object({
  kind: z.literal("stochastic"),
  when: simfileWhenSchema.optional(),
  variable: simfileIdentifierSchema,
  uniform: z.tuple([z.number(), z.number()])
}).strict();

export const simfileGeneratorSchema = z.union([
  simfileGeneratorDeterministicSchema,
  simfileGeneratorStochasticSchema
]);

export const simfileRuleActionSchema = z.union([
  z.object({
    action: z.literal("moltnet:message"),
    to: simfileRoomScopeSchema,
    content: z.string().min(1)
  }).strict(),
  z.object({
    action: z.literal("moltnet:dm"),
    to: simfileAgentScopeSchema,
    content: z.string().min(1)
  }).strict(),
  z.object({
    action: z.literal("wake:recommend"),
    to: simfileRoomScopeSchema
  }).strict(),
  z.object({
    action: z.literal("variable:set"),
    variable: simfileIdentifierSchema,
    value: z.number()
  }).strict(),
  z.object({
    action: z.literal("variable:delta"),
    variable: simfileIdentifierSchema,
    value: z.number()
  }).strict()
]);

export const simfileRuleSchema = z.object({
  fire: z.enum(["once", "per_crossing"]).default("per_crossing"),
  when: simfileWhenSchema,
  do: z.array(simfileRuleActionSchema).min(1)
}).strict();

export const simfileLedgerSchema = z.object({
  store: z.object({
    kind: z.enum(["jsonl", "sqlite", "postgres"]).default("jsonl"),
    path: z.string().min(1).optional()
  }).strict()
}).strict();

export const simfileTelemetrySchema = z.object({
  snapshot_every: z.number().int().positive().optional()
}).strict();

export const simfileMarkerSchema = z.object({
  text: z.array(z.string().min(1)).optional(),
  mode: z.enum(["containment", "propagation"]),
  scopes: z.array(simfileScopeSchema).min(1)
}).strict();

const simfileProbeExpectationSchema = z.union([
  z.object({ at_least: z.number().int().nonnegative() }).strict(),
  z.object({ at_most: z.number().int().nonnegative() }).strict(),
  z.object({ always: z.literal(true) }).strict(),
  z.object({ at_end: z.literal(true) }).strict()
]).superRefine((expectation, context) => {
  const keys = Object.keys(expectation);
  if (keys.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "expect must contain one of at_least, at_most, always, or at_end",
      path: []
    });
  }
});

export const simfileProbeSchema = z.object({
  when: simfileWhenSchema,
  expect: simfileProbeExpectationSchema,
  after: simfileWhenSchema.optional(),
  within: simfileDurationSchema.optional()
}).superRefine((value, context) => {
  if (value.within !== undefined && value.after === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "within requires after",
      path: ["within"]
    });
  }
  if (value.after !== undefined && value.within === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "after requires within",
      path: ["after"]
    });
  }
}).strict();

export const simfileSchema = z.object({
  simfile_version: z.literal("0.1"),
  name: simfileIdentifierSchema,
  spawnfile: z.string().optional(),
  clock: simfileClockSchema,
  variables: z.record(simfileIdentifierSchema, simfileVariableSchema).default({}),
  generators: z.record(simfileIdentifierSchema, simfileGeneratorSchema).default({}),
  rules: z.record(simfileIdentifierSchema, simfileRuleSchema).default({}),
  ledger: simfileLedgerSchema.optional(),
  telemetry: simfileTelemetrySchema.optional(),
  markers: z.record(simfileIdentifierSchema, simfileMarkerSchema).default({}),
  probes: z.record(simfileIdentifierSchema, simfileProbeSchema).default({})
}).strict();

export type Simfile = z.infer<typeof simfileSchema>;
export type SimfileClock = z.infer<typeof simfileClockSchema>;
export type SimfileGenerator = z.infer<typeof simfileGeneratorSchema>;
export type SimfileRule = z.infer<typeof simfileRuleSchema>;
export type SimfileLedger = z.infer<typeof simfileLedgerSchema>;
export type SimfileProbe = z.infer<typeof simfileProbeSchema>;
export type SimfileRuleAction = z.infer<typeof simfileRuleActionSchema>;
export type SimfileVariable = z.infer<typeof simfileVariableSchema>;
