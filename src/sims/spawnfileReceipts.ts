import { z } from "zod";

/**
 * Minimal local schemas for the THREE documented `spawnfile ... --json`
 * receipts the composed-run driver shells (contracts.md's CLI rule: "simfile
 * -> spawnfile only through documented CLI + versioned receipts"). These are
 * deliberately NOT imported from Spawnfile's own `src/deployment/*Types.ts` —
 * this package's charter ("Do not import Spawnfile internals. Consume
 * explicit machine-readable artifacts.") means simfile treats each receipt as
 * an external wire contract it parses on its own terms, the same way
 * `observe/manifest.ts` and `observe/report.ts` own their schemas rather than
 * importing anyone else's. Every schema below is intentionally loose
 * (`.passthrough()`, no `.strict()`) and only asserts the fields this driver
 * actually reads, so an additive field on the real contract never breaks
 * parsing here.
 */

const upReceiptSchema = z
  .object({
    version: z.string().min(1),
    run_id: z.string().min(1).nullable(),
    fingerprint: z.string().min(1).optional(),
    deployment: z
      .object({
        name: z.string().min(1).nullable(),
        container_ids: z.array(z.string())
      })
      .passthrough(),
    readiness: z
      .object({
        state: z.string(),
        moltnet_base_url: z.string().min(1).nullable()
      })
      .passthrough(),
    engines: z
      .array(
        z
          .object({
            agent: z.string().min(1),
            engine: z.string().min(1)
          })
          .passthrough()
      )
      .optional()
  })
  .passthrough();

export type SpawnfileUpReceipt = z.infer<typeof upReceiptSchema>;

/** Parses `spawnfile up --json`'s stdout (`spawnfile.up-receipt.v1`). */
export const parseSpawnfileUpReceipt = (raw: unknown): SpawnfileUpReceipt => {
  const result = upReceiptSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid spawnfile up-receipt: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};

const exportIndexFileSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    bytes: z.number().int().nonnegative().optional(),
    source: z.unknown().optional()
  })
  .passthrough();

const exportResultSchema = z
  .object({
    deployment: z.string().min(1),
    failed_files: z.array(z.string()).default([]),
    missing_optional_files: z.array(z.string()).default([]),
    index_path: z.string().min(1),
    index: z
      .object({
        version: z.string().min(1),
        run_id: z.string().min(1),
        deployment: z.string().min(1),
        exported_at: z.string().min(1),
        files: z.array(exportIndexFileSchema)
      })
      .passthrough()
  })
  .passthrough();

export type SpawnfileExportResult = z.infer<typeof exportResultSchema>;
export type SpawnfileExportIndexFile = z.infer<typeof exportIndexFileSchema>;

/** Parses `spawnfile artifacts export --json`'s stdout (folds
 * `spawnfile.export-index.v1` inside `index`). */
export const parseSpawnfileExportResult = (raw: unknown): SpawnfileExportResult => {
  const result = exportResultSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid spawnfile artifacts export result: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};

const downReceiptSchema = z
  .object({
    version: z.string().min(1),
    deployment: z.string().min(1),
    units_stopped: z.array(z.string()).default([]),
    retained_volumes: z.array(z.string()).default([]),
    errors: z.array(z.string()).default([])
  })
  .passthrough();

export type SpawnfileDownReceipt = z.infer<typeof downReceiptSchema>;

/** Parses `spawnfile down --json`'s stdout (`spawnfile.down-receipt.v1`). */
export const parseSpawnfileDownReceipt = (raw: unknown): SpawnfileDownReceipt => {
  const result = downReceiptSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `invalid spawnfile down-receipt: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return result.data;
};
