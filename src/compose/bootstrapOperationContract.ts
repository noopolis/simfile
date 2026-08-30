import { z } from "zod";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const COMPOSED_BOOTSTRAP_OPERATION_KINDS = Object.freeze([
  "resolve_target_config",
  "select_target",
  "prepare_container_bundle",
  "provision_credentials",
  "prepare_composed_run",
] as const);

export const composedBootstrapOperationSchema = z.object({
  kind: z.enum(COMPOSED_BOOTSTRAP_OPERATION_KINDS),
  operation_id: digest,
  recorded_at: z.string().datetime({ offset: true }),
  request: z.record(z.string(), z.unknown()),
  request_digest: digest,
  sequence: z.number().int().min(0).max(15),
  state: z.enum([
    "ambiguous",
    "completed",
    "intent_durable",
    "lookup_required",
    "not_applied",
    "pending",
  ]),
  receipt: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ComposedBootstrapOperation = z.infer<
  typeof composedBootstrapOperationSchema
>;
