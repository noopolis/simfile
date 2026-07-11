import { z } from "zod";

/**
 * `simfile.run-manifest.v1` — the composite run manifest simfile writes for
 * a run's directory (Decision 21 / contracts.md's `simfile.run-manifest.v1`
 * row). `seed_declaration` and `expected_wakes` are DEFINED-BUT-OPTIONAL:
 * office-sim runs omit both (no seeded secret, no compiled wake schedule to
 * diff against yet), so a manifest without them is still fully conformant.
 * A future memetics phase (Phase G) populates both without a v2 bump.
 */
export const RUN_MANIFEST_VERSION = "simfile.run-manifest.v1" as const;

const artifactEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u, "sha256 must be a 64-character lowercase hex digest")
  })
  .strict();

export type RunManifestArtifactEntry = z.infer<typeof artifactEntrySchema>;

const spawnfileRefSchema = z
  .object({
    up_receipt_ref: z.string().min(1).optional(),
    fingerprint: z.string().min(1).optional()
  })
  .strict();

/**
 * The observer's ground truth for a seeded memetics secret (contracts.md
 * "measurement-critical contracts" section). `matcher_policy` is kept as a
 * documented free-form string rather than a tight enum: the four named
 * policies (`exact` / `edit-distance<=k` / `embedding>=tau` / `judge-model`)
 * are parameterized (the `k`/`tau` varies per experiment) and no experiment
 * has pinned one yet — narrowing this before Phase G actually uses it would
 * guess at a shape instead of freezing an observed one.
 */
const seedDeclarationSchema = z
  .object({
    content_hash: z.string().min(1),
    token_set: z.array(z.string().min(1)),
    matcher_policy: z.string().min(1),
    seed_agent: z.string().min(1),
    seed_epoch: z.string().min(1),
    entry_channel: z.literal("doc-seeded")
  })
  .strict();

export type SeedDeclaration = z.infer<typeof seedDeclarationSchema>;

/**
 * One compiled schedule fire simfile expects to observe within the run's
 * sim-time window (the denominator oracle for the 100%-reply-or-recover
 * bar, contracts.md). Kept minimal and generic: the compiled-schedule ->
 * wake-diff lowering is Phase 7 scope (Decision 21's phasing), so this only
 * carries what `simfile observe`'s wake-diff will need to match against —
 * which agent, which wake, and when.
 */
const expectedWakeSchema = z
  .object({
    agent_id: z.string().min(1),
    wake_id: z.string().min(1),
    sim_time: z.number().optional()
  })
  .strict();

export type ExpectedWake = z.infer<typeof expectedWakeSchema>;

export const runManifestSchema = z
  .object({
    version: z.literal(RUN_MANIFEST_VERSION),
    run_id: z.string().min(1),
    created_at: z.string().min(1),
    contract_versions: z.record(z.string(), z.string()),
    spawnfile: spawnfileRefSchema.optional(),
    artifacts: z.array(artifactEntrySchema),
    engine: z.string().min(1).optional(),
    world: z.record(z.string(), z.unknown()).optional(),
    seed_declaration: seedDeclarationSchema.optional(),
    expected_wakes: z.array(expectedWakeSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (Number.isNaN(Date.parse(value.created_at))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "created_at must be a valid ISO 8601 timestamp",
        path: ["created_at"]
      });
    }
  });

export type SimfileRunManifest = z.infer<typeof runManifestSchema>;

export const parseRunManifest = (raw: unknown): SimfileRunManifest => {
  const result = runManifestSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid ${RUN_MANIFEST_VERSION} manifest: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};
