/**
 * World-grant observation has three recorded states plus absence: an absent
 * marker means no marker was recorded; `none-declared` means Simfile declared
 * no world grants; `declared-unresolved` means grants were declared but have
 * not yet been resolved or observed; and `declared-resolved` means declared
 * grants were resolved.
 */
import { z } from "zod";

import type { SimfileRunManifest } from "./manifest.js";

export const OBSERVE_WORLD_GRANT_STATUSES = [
  "none-declared",
  "declared-unresolved",
  "declared-resolved"
] as const;

/**
 * Forward compatibility is deliberately fail-loud: a future producer status
 * or marker field must not be silently discarded or misclassified by an older
 * observer. Extend this schema when the manifest marker contract grows.
 */
export const observeWorldGrantsSchema = z
  .object({
    status: z.enum(OBSERVE_WORLD_GRANT_STATUSES),
    participants: z.array(z.string().min(1)),
    resolved: z.boolean(),
    observed: z.boolean(),
    deferred_to: z.string().min(1).optional()
  })
  .strict();

export type ObserveWorldGrants = z.infer<typeof observeWorldGrantsSchema>;

export const worldGrantsFromManifest = (
  manifest: SimfileRunManifest
): ObserveWorldGrants | undefined => {
  const marker = manifest.world?.world_grants;
  if (marker === undefined) return undefined;

  const result = observeWorldGrantsSchema.safeParse(marker);
  if (!result.success) {
    throw new Error(
      `invalid manifest world.world_grants marker: ${result.error.issues
        .map((issue) =>
          `world.world_grants.${issue.path.join(".") || "<root>"}: ${issue.message}`
        )
        .join("; ")}`
    );
  }
  return result.data;
};
