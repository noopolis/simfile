import { z } from "zod";

import { observeWorldGrantsSchema } from "./worldGrants.js";

const socialPlaneMessageSchema = z.object({
  message_id: z.string().min(1), rendered_attribution: z.string(), authenticated_principal: z.string().nullable(),
  attribution: z.enum(["attested", "violated", "unattested"]), content_sha256_matches: z.boolean()
}).strict();
const socialPlaneSchema = z.object({
  messages: z.object({ count: z.number().int().min(0), entries: z.array(socialPlaneMessageSchema) }).strict(),
  world_state: z.object({ passed: z.boolean(), violations: z.array(z.object({ message_id: z.string().min(1), keys: z.array(z.string()) }).strict()) }).strict(),
  actions: z.object({ passed: z.boolean(), basis: z.string().min(1), violations: z.array(z.object({ message_id: z.string().min(1), action_event_id: z.string().min(1), relation: z.literal("causal-ancestor") }).strict()) }).strict(),
  attribution: z.object({ attested: z.number().int().min(0), violated: z.number().int().min(0), unattested: z.number().int().min(0) }).strict(),
  verdict: z.object({ passed: z.boolean(), status: z.enum(["passed", "failed", "incomplete"]), reasons: z.array(z.string()) }).strict()
}).strict();

export type SocialPlane = z.infer<typeof socialPlaneSchema>;

const worldActionEvidenceSchema = z.object({
  action: z.string(), origin: z.string().nullable(), principal: z.string().nullable(), has_decision_id: z.boolean()
}).strict();
const worldEvidenceSchema = z.object({
  actions: z.object({ count: z.number().int().min(0), entries: z.array(worldActionEvidenceSchema) }).strict(),
  perception: z.object({ count: z.number().int().min(0), principals: z.array(z.string()) }).strict(),
  refusals: z.object({ count: z.number().int().min(0), reasons: z.array(z.string()) }).strict(),
  possession: z.object({ changes_recorded: z.number().int().min(0), covered: z.boolean(), first_change_tick: z.number().optional(), last_change_tick: z.number().optional() }).strict(),
  pace: z.object({ measured_wall_elapsed_seconds: z.number().nonnegative(), declared_sim_seconds_per_tick: z.number().nonnegative(), target_sim_seconds: z.number().nonnegative(), kept_up: z.boolean() }).strict(),
  verdict: z.object({ passed: z.boolean(), status: z.enum(["passed", "failed", "incomplete"]), reasons: z.array(z.string()) }).strict()
}).strict();

/**
 * `simfile.observe.v1` — the report `simfile observe <run-dir>` emits
 * (Decision 21 / contracts.md's `simfile.observe.v1` row, the one contract
 * id: `spawnfile.spread-report.v1` is a removed alias, never revived here).
 * `seed_spread`, `spread_summary`, and `wake_diff` are DEFINED-BUT-OPTIONAL
 * and omitted for the office-sim golden fixture (no seeded secret, no
 * compiled wake schedule); memetics increment (b) populates `seed_spread`/
 * `spread_summary` for a seed-declared run without a v2 bump.
 * `world_grants` is also a DEFINED-BUT-OPTIONAL compatible v1 amendment: it
 * surfaces the manifest's recorded grant marker without invalidating saved v1
 * reports. Omission means "no marker recorded", not "no grants declared", so
 * this amendment does not bump the literal to v2.
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

/**
 * Where `memory.events` (the write-count proxy) for a bank came from —
 * Slice B Piece 4b. `"ledger"` means at least one `memory.written` causal
 * event was reconciled for the bank (mneme's write-side envelope);
 * `"events-fallback"` means the count instead came from the interim signal
 * (mneme's own `events.jsonl` bank log, or that bank's `memory.recalled`
 * causal events if even that is absent). Optional so a pre-4b serialized
 * report (no source marker at all) still validates.
 */
export const MEMORY_WRITE_SOURCES = ["ledger", "events-fallback"] as const;
export type MemoryWriteSource = (typeof MEMORY_WRITE_SOURCES)[number];

const memoryBankEntrySchema = z
  .object({
    bank: z.string().min(1),
    events: z.number().int().min(0),
    recalls: z.number().int().min(0),
    memory_write_source: z.enum(MEMORY_WRITE_SOURCES).optional(),
    writes_by_agent: z.record(z.string(), z.number().int().min(0)).optional()
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

/**
 * Memetics increment (b): `agent`/`tick`/`memory_write_source` are a
 * compatible v1 amendment (`seed_spread` was frozen DEFINED-BUT-OPTIONAL
 * precisely so a later phase could grow the entry shape without a v2 bump).
 * `agent` is the principal simfile observe attributes the hit to (never the
 * seed agent for a `doc-seeded` entry's own later channels — reach/latency
 * math excludes the seed agent, this field alone doesn't). `tick` is the
 * world's own tick counter, joined from `world/ingested-messages.jsonl`
 * (an `uttered` hit) or traced back to the moltnet message that caused it
 * (a `registered`/`recalled` hit whose ledger event chains back that far) —
 * never fabricated; omitted when no such join exists. `memory_write_source`
 * mirrors `MemoryWriteSource` (Slice B Piece 4b) but scoped to this single
 * `registered` hit, not a whole bank.
 */
const seedSpreadSchema = z
  .object({
    channel: z.enum(SEED_SPREAD_CHANNELS),
    event_id: z.string().min(1),
    fidelity: z.number().min(0).max(1).optional(),
    agent: z.string().min(1).optional(),
    tick: z.number().int().min(0).optional(),
    memory_write_source: z.enum(MEMORY_WRITE_SOURCES).optional()
  })
  .strict();

export type SeedSpreadEntry = z.infer<typeof seedSpreadSchema>;

/** One non-seed agent's earliest re-derived appearance, across every channel. */
const spreadFirstAppearanceSchema = z
  .object({
    agent: z.string().min(1),
    channel: z.enum(SEED_SPREAD_CHANNELS),
    event_id: z.string().min(1),
    tick: z.number().int().min(0).optional()
  })
  .strict();

/**
 * The smallest honest summary of `seed_spread` (memetics increment (b)):
 * `reach` counts non-seed agents with any post-seed appearance; `latency`
 * is the lowest known `tick` among those appearances (omitted when no
 * appearance carries a `tick`) — ticks/causal steps from the seed epoch to
 * first spread, never wall-clock. Derivable from `seed_spread` alone, but
 * kept as its own field so a consumer (the viewer) doesn't have to
 * re-implement the derivation.
 */
const spreadSummarySchema = z
  .object({
    reach: z.number().int().min(0),
    latency: z.number().int().min(0).optional(),
    first_appearance: z.array(spreadFirstAppearanceSchema)
  })
  .strict();

export type SpreadSummary = z.infer<typeof spreadSummarySchema>;

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
    spread_summary: spreadSummarySchema.optional(),
    wake_diff: z.array(wakeDiffEntrySchema).optional(),
    world_grants: observeWorldGrantsSchema.optional(),
    world_evidence: worldEvidenceSchema.optional()
    ,social_plane: socialPlaneSchema.optional()
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
