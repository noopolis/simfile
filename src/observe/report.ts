import { z } from "zod";

/**
 * `simfile.observe.v1` — the report `simfile observe <run-dir>` emits
 * (Decision 21 / contracts.md's `simfile.observe.v1` row, the one contract
 * id: `spawnfile.spread-report.v1` is a removed alias, never revived here).
 * `seed_spread` and `wake_diff` are DEFINED-BUT-OPTIONAL and omitted for the
 * office-sim golden fixture (no seeded secret, no compiled wake schedule);
 * a future memetics phase populates both without a v2 bump.
 */
export const OBSERVE_REPORT_VERSION = "simfile.observe.v1" as const;

/** Precedence order matches `@noopolis/stele`'s `reconcileEvents` states,
 * minus "complete" (that count lives in `chains.complete`, not the flagged list). */
export const INCOMPLETE_CHAIN_FLAGS = ["divergent", "unknown", "partial", "stale"] as const;
export type IncompleteChainFlag = (typeof INCOMPLETE_CHAIN_FLAGS)[number];

const incompleteChainEntrySchema = z
  .object({
    event_id: z.string().min(1),
    flag: z.enum(INCOMPLETE_CHAIN_FLAGS)
  })
  .strict();

const memoryBankEntrySchema = z
  .object({
    bank: z.string().min(1),
    events: z.number().int().min(0),
    recalls: z.number().int().min(0)
  })
  .strict();

const failureEntrySchema = z
  .object({
    reason: z.string().min(1),
    event_id: z.string().min(1)
  })
  .strict();

/** `doc-seeded` is added (contracts.md) so a seed's entry channel is
 * representable and never misclassified as spontaneous invention. */
export const SEED_SPREAD_CHANNELS = ["doc-seeded", "uttered", "registered", "recalled"] as const;
export type SeedSpreadChannel = (typeof SEED_SPREAD_CHANNELS)[number];

const seedSpreadSchema = z
  .object({
    channel: z.enum(SEED_SPREAD_CHANNELS),
    event_id: z.string().min(1),
    fidelity: z.number().min(0).max(1).optional()
  })
  .strict();

const wakeDiffEntrySchema = z
  .object({
    agent_id: z.string().min(1),
    wake_id: z.string().min(1),
    status: z.enum(["delivered", "wake-not-delivered"])
  })
  .strict();

export const observeReportSchema = z
  .object({
    version: z.literal(OBSERVE_REPORT_VERSION),
    run_id: z.string().min(1),
    contract_versions: z.record(z.string(), z.string()),
    participants: z.array(z.string().min(1)),
    agent_turns: z
      .object({
        count: z.number().int().min(0),
        sequence: z.array(z.string().min(1))
      })
      .strict(),
    chains: z
      .object({
        complete: z.number().int().min(0),
        incomplete: z.array(incompleteChainEntrySchema)
      })
      .strict(),
    memory: z.array(memoryBankEntrySchema),
    failures: z.array(failureEntrySchema),
    seed_spread: z.array(seedSpreadSchema).optional(),
    wake_diff: z.array(wakeDiffEntrySchema).optional()
  })
  .strict();

export type SimfileObserveReport = z.infer<typeof observeReportSchema>;

export const parseObserveReport = (raw: unknown): SimfileObserveReport => {
  const result = observeReportSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid ${OBSERVE_REPORT_VERSION} report: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};
