import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyManifestArtifacts } from "../observe/artifacts.js";
import { parseRunManifest } from "../observe/manifest.js";
import { assertSecretFreeComposedJson } from "./json.js";

export interface PrincipalStrategicActionCount {
  readonly count: number;
  readonly participant: string;
  readonly principal: string;
}
export interface ComposedLiveEvidenceVerdict {
  readonly counts: readonly PrincipalStrategicActionCount[];
  readonly state: "passed" | "failed";
  readonly zero_action_principals: readonly string[];
}

const exact = (raw: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  assertSecretFreeComposedJson(raw);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`composed ${label} evidence is invalid`);
  }
  return raw as Record<string, unknown>;
};
const text = (raw: unknown, label: string): string => {
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(raw)) {
    throw new TypeError(`composed ${label} evidence is invalid`);
  }
  return raw;
};
const artifactRole = (inventory: unknown, artifactPath: string, role: string): void => {
  const root = exact(inventory, ["artifacts", "run_id", "version"], "inventory");
  if (root.version !== "simfile.composed-run-inventory.v1" || !Array.isArray(root.artifacts)) {
    throw new TypeError("composed inventory evidence is invalid");
  }
  const entry = root.artifacts.find((candidate) => candidate !== null
    && typeof candidate === "object" && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).path === artifactPath);
  if (entry === undefined || exact(entry, ["path", "role", "sha256"], "inventory entry").role !== role) {
    throw new TypeError(`composed ${role} evidence role is invalid`);
  }
};

/** Derives live-agent counts only after seal from authenticated world evidence. */
export const deriveComposedLiveEvidence = async (input: Readonly<{
  accepted_actions_path: string;
  principals_path: string;
  run_dir: string;
}>): Promise<ComposedLiveEvidenceVerdict> => {
  const runDir = path.resolve(input.run_dir);
  const manifest = parseRunManifest(JSON.parse(
    await readFile(path.join(runDir, "manifest.json"), "utf8"),
  ) as unknown);
  const checks = await verifyManifestArtifacts(runDir, manifest.artifacts);
  const failed = checks.find(({ ok }) => !ok);
  if (failed !== undefined) throw new TypeError(`composed live evidence mismatch: ${failed.path}`);
  const declared = new Set(manifest.artifacts.map(({ path: artifactPath }) => artifactPath));
  if (!declared.has("inventory.json") || !declared.has(input.accepted_actions_path)
    || !declared.has(input.principals_path)) {
    throw new TypeError("composed live evidence is not manifest-declared");
  }
  const [inventory, principalsRaw, actionsRaw] = await Promise.all([
    readFile(path.join(runDir, "inventory.json"), "utf8").then((value) => JSON.parse(value) as unknown),
    readFile(path.join(runDir, input.principals_path), "utf8").then((value) => JSON.parse(value) as unknown),
    readFile(path.join(runDir, input.accepted_actions_path), "utf8").then((value) => JSON.parse(value) as unknown),
  ]);
  artifactRole(inventory, input.principals_path, "identity");
  artifactRole(inventory, input.accepted_actions_path, "accepted-action");
  const principalsRoot = exact(principalsRaw, ["principals", "run_id", "version"], "principal");
  const actionsRoot = exact(actionsRaw, ["actions", "run_id", "version"], "accepted action");
  if (principalsRoot.version !== "simfile.composed-principals.v1"
    || actionsRoot.version !== "simfile.accepted-strategic-actions.v1"
    || principalsRoot.run_id !== manifest.run_id || actionsRoot.run_id !== manifest.run_id
    || !Array.isArray(principalsRoot.principals) || !Array.isArray(actionsRoot.actions)
    || principalsRoot.principals.length < 1 || principalsRoot.principals.length > 4_096
    || actionsRoot.actions.length > 1_000_000) {
    throw new TypeError("composed live evidence identity is invalid");
  }
  const counts = principalsRoot.principals.map((raw) => {
    const principal = exact(raw, ["participant", "principal"], "principal");
    return { count: 0, participant: text(principal.participant, "participant"),
      principal: text(principal.principal, "principal") };
  }).sort((left, right) => left.principal.localeCompare(right.principal));
  if (new Set(counts.map(({ principal }) => principal)).size !== counts.length
    || new Set(counts.map(({ participant }) => participant)).size !== counts.length) {
    throw new TypeError("composed live evidence principals are duplicated");
  }
  const byPrincipal = new Map(counts.map((entry) => [entry.principal, entry]));
  const receipts = new Set<string>();
  for (const raw of actionsRoot.actions) {
    const action = exact(raw, ["authenticated", "disposition", "participant", "principal",
      "receipt_id"], "accepted action");
    const principal = text(action.principal, "principal");
    const participant = text(action.participant, "participant");
    const receipt = text(action.receipt_id, "receipt");
    const count = byPrincipal.get(principal);
    if (action.authenticated !== true || action.disposition !== "applied"
      || count === undefined || count.participant !== participant || receipts.has(receipt)) {
      throw new TypeError("composed accepted action evidence is invalid");
    }
    receipts.add(receipt); count.count += 1;
  }
  const frozenCounts = Object.freeze(counts.map((entry) => Object.freeze({ ...entry })));
  const zero = Object.freeze(frozenCounts.filter(({ count }) => count === 0)
    .map(({ principal }) => principal));
  return Object.freeze({ counts: frozenCounts, state: zero.length === 0 ? "passed" : "failed",
    zero_action_principals: zero });
};

