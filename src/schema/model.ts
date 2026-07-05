import { z } from "zod";

export const simfileIdentifierSchema = z.string()
  .min(1)
  .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u, {
    message: "expected lowercase identifier with letters, numbers, dashes, or underscores"
  });

const boundedNumberSchema = z.number().min(0).max(1);

const scalarMapSchema = z.record(simfileIdentifierSchema, boundedNumberSchema);

export const simfileClockSchema = z.object({
  tick: z.string().min(1),
  phases: z.array(z.object({
    id: simfileIdentifierSchema,
    starts: z.string().min(1)
  })).min(1)
});

export const simfileActorSchema = z.object({
  id: simfileIdentifierSchema,
  agent: simfileIdentifierSchema.optional(),
  description: z.string().optional(),
  needs: scalarMapSchema.optional(),
  traits: scalarMapSchema.optional(),
  values: scalarMapSchema.optional()
});

export const simfileLocationSchema = z.object({
  id: simfileIdentifierSchema,
  room: z.string().min(1).optional(),
  description: z.string().optional(),
  pressures: scalarMapSchema.optional()
});

export const simfileActionSchema = z.object({
  id: simfileIdentifierSchema,
  description: z.string().optional(),
  preconditions: z.array(z.string().min(1)).optional(),
  effects: z.array(z.string().min(1)).optional()
});

export const simfileSalienceRuleSchema = z.object({
  need: simfileIdentifierSchema.optional(),
  pressure: simfileIdentifierSchema.optional(),
  above: boundedNumberSchema.optional(),
  below: boundedNumberSchema.optional(),
  wake: z.boolean().optional()
}).refine((rule) => rule.need !== undefined || rule.pressure !== undefined, {
  message: "salience rule must reference a need or pressure"
}).refine((rule) => rule.above !== undefined || rule.below !== undefined, {
  message: "salience rule must define above or below"
});

export const simfileSalienceSchema = z.object({
  wake_when: z.array(simfileSalienceRuleSchema).default([])
}).optional();

export const simfileLedgerSchema = z.object({
  events: z.array(z.string().min(1)).default([])
}).optional();

export const simfileSchema = z.object({
  simfile_version: z.literal("0.1"),
  kind: z.literal("simulation"),
  name: simfileIdentifierSchema,
  description: z.string().optional(),
  clock: simfileClockSchema,
  actors: z.array(simfileActorSchema).default([]),
  locations: z.array(simfileLocationSchema).default([]),
  actions: z.array(simfileActionSchema).default([]),
  salience: simfileSalienceSchema,
  ledger: simfileLedgerSchema
});

export type Simfile = z.infer<typeof simfileSchema>;
export type SimfileAction = z.infer<typeof simfileActionSchema>;
export type SimfileActor = z.infer<typeof simfileActorSchema>;
export type SimfileClock = z.infer<typeof simfileClockSchema>;
export type SimfileLedger = z.infer<typeof simfileLedgerSchema>;
export type SimfileLocation = z.infer<typeof simfileLocationSchema>;
export type SimfileSalienceRule = z.infer<typeof simfileSalienceRuleSchema>;
