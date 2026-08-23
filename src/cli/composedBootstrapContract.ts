import { createHash } from "node:crypto";

import {
  composedOrganizationExportLifecycleInvocationId,
  composedRunIdSchema,
} from "../compose/index.js";
import { digestComposedJson } from "../compose/json.js";

export const sha256 = (bytes: Uint8Array | string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const key = (domain: string, value: unknown): string =>
  digestComposedJson(domain, value).slice(7, 39);

export const composedOrganizationContainerName = (runId: string): string =>
  `simfile-org-${key("simfile.composed-container.v1", runId).slice(0, 16)}`;
export const composedDeploymentName = (runId: string): string =>
  `simfile-${key("simfile.composed-deployment.v1", runId).slice(0, 16)}`;
export const composedOrganizationUnitId = (runId: string): string =>
  `${composedDeploymentName(runId)}-container`;
export const composedHandoffRunEnvironment = (
  runId: string,
): Readonly<Record<string, string>> =>
  Object.freeze({ NOOPOLIS_RUN_ID: composedRunIdSchema.parse(runId) });
export const composedProviderLifecycleInvocations = (
  runId: string,
  requestDigest: string,
) => Object.freeze({
  down: `lci_${key("simfile.composed-lifecycle.down.v1", runId)}`,
  export: composedOrganizationExportLifecycleInvocationId(requestDigest),
  up: `lci_${key("simfile.composed-lifecycle.up.v1", runId)}`,
});

export const composedIdempotencyKey = (
  domain: string,
  value: unknown,
): string => `idem_${key(domain, value)}`;
