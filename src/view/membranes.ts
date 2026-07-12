import { readFile } from "node:fs/promises";
import path from "node:path";

import { agentRef, roomRef } from "./runTimelineRefs.js";
import type { RunTimelineMembrane } from "./runTimelineTypes.js";

/**
 * Derives the `RunTimeline.membranes` (the "descend into a mind" structure)
 * from a `spawnfile-report.json` compile report — the report the composed
 * driver copies into the run-dir. A membrane is an interior self-team: a team
 * that owns its own Moltnet network and is represented on a parent floor by
 * one of its members (its lead/external representative).
 *
 * Simfile never imports Spawnfile TS internals (charter). The compile report
 * is a documented machine-readable artifact, so this module parses only the
 * loose subset it needs — `nodes[].active_environments.moltnet` (the
 * representative -> team linkage) and `container.moltnet.server_plans[]` (the
 * interior room membership) — defensively, ignoring everything else.
 *
 * Why `active_environments` is the definitive signal for "which room is
 * interior vs parent": a representative agent is a member of TWO rooms, and in
 * the parent room its `member_slot` is the TEAM it stands in for (not its own
 * id), while in its own council room `member_slot` is its own id. That
 * asymmetry — unavailable from `server_plans` alone — is what tells interior
 * from outer without guessing at nesting.
 */

interface ReportMoltnetBinding {
  member_slot?: unknown;
  team_id?: unknown;
}

interface ReportRoomBinding {
  rooms?: Record<string, ReportMoltnetBinding> | unknown;
}

interface ReportNode {
  id?: unknown;
  kind?: unknown;
  active_environments?: { moltnet?: Record<string, ReportRoomBinding> | unknown } | unknown;
}

interface ReportServerPlanRoom {
  id?: unknown;
  members?: unknown;
}

interface ReportServerPlan {
  id?: unknown;
  network_id?: unknown;
  rooms?: unknown;
}

interface CompileReportShape {
  nodes?: unknown;
  container?: { moltnet?: { server_plans?: unknown } | unknown } | unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const stripPrefix = (id: string, prefix: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id);

/** Team-slug set: every `nodes[]` entry with `kind: "team"`, stripped of the `team:` id prefix. */
const collectTeamSlugs = (report: CompileReportShape): Set<string> => {
  const teams = new Set<string>();
  const nodes = Array.isArray(report.nodes) ? (report.nodes as ReportNode[]) : [];
  for (const node of nodes) {
    if (asString(node.kind) === "team") {
      const id = asString(node.id);
      if (id) teams.add(stripPrefix(id, "team:"));
    }
  }
  return teams;
};

/**
 * team-slug -> representative `agent:<id>` ref, read from every agent node's
 * `active_environments.moltnet[network][room].member_slot`: when that slot is
 * a known team slug OTHER than the agent's own id, this agent is that team's
 * representative on a parent floor.
 */
const collectRepresentatives = (report: CompileReportShape, teamSlugs: Set<string>): Map<string, string> => {
  const byTeam = new Map<string, string>();
  const nodes = Array.isArray(report.nodes) ? (report.nodes as ReportNode[]) : [];
  for (const node of nodes) {
    if (asString(node.kind) !== "agent") continue;
    const nodeId = asString(node.id);
    if (!nodeId) continue;
    const agentSlug = stripPrefix(nodeId, "agent:");

    const active = asRecord(node.active_environments);
    const moltnet = asRecord(active?.moltnet);
    if (!moltnet) continue;

    for (const networkBinding of Object.values(moltnet)) {
      const rooms = asRecord(asRecord(networkBinding)?.rooms);
      if (!rooms) continue;
      for (const roomBinding of Object.values(rooms)) {
        const slot = asString(asRecord(roomBinding)?.member_slot);
        if (slot && slot !== agentSlug && teamSlugs.has(slot) && !byTeam.has(slot)) {
          byTeam.set(slot, agentRef(agentSlug));
        }
      }
    }
  }
  return byTeam;
};

/** The `server_plans[]` a team owns, matched by the compiler's `id === `${teamSlug}-${networkId}`` convention. */
const ownedServerPlans = (report: CompileReportShape, teamSlug: string): ReportServerPlan[] => {
  const moltnet = asRecord(asRecord(report.container)?.moltnet);
  const plans = Array.isArray((moltnet as { server_plans?: unknown })?.server_plans)
    ? ((moltnet as { server_plans: unknown[] }).server_plans as ReportServerPlan[])
    : [];
  return plans.filter((plan) => {
    const id = asString(plan.id);
    const networkId = asString(plan.network_id);
    return Boolean(id && networkId && id === `${teamSlug}-${networkId}`);
  });
};

/**
 * Builds the membranes array. Empty (never throwing) when the report is
 * absent/unparseable or declares no interior self-teams — the office-sim
 * golden (no teams, no report in its run-dir) legitimately yields `[]`.
 */
export const deriveMembranes = (report: unknown): RunTimelineMembrane[] => {
  const shape = asRecord(report) as CompileReportShape | undefined;
  if (!shape) return [];

  const teamSlugs = collectTeamSlugs(shape);
  const representatives = collectRepresentatives(shape, teamSlugs);

  const membranes: RunTimelineMembrane[] = [];
  for (const [teamSlug, representative] of representatives) {
    const plans = ownedServerPlans(shape, teamSlug);
    if (plans.length === 0) continue;

    const interiorRooms: string[] = [];
    const members = new Set<string>();
    for (const plan of plans) {
      const networkId = asString(plan.network_id);
      const rooms = Array.isArray(plan.rooms) ? (plan.rooms as ReportServerPlanRoom[]) : [];
      for (const room of rooms) {
        const roomId = asString(room.id);
        if (!networkId || !roomId) continue;
        interiorRooms.push(roomRef(networkId, roomId));
        const roomMembers = Array.isArray(room.members) ? (room.members as unknown[]) : [];
        for (const member of roomMembers) {
          const memberId = asString(member);
          if (memberId) members.add(agentRef(memberId));
        }
      }
    }
    if (interiorRooms.length === 0) continue;

    membranes.push({
      ref: `team:${teamSlug}`,
      label: teamSlug,
      representative,
      interiorRooms: interiorRooms.sort(),
      members: [...members].sort()
    });
  }

  return membranes.sort((left, right) => left.ref.localeCompare(right.ref));
};

/**
 * Reads `spawnfile-report.json` from a run-dir and derives its membranes.
 * Returns `[]` when the file is missing (a non-composed or single-team run
 * that never copied a report in) — never throws for a run without one.
 */
export const readRunMembranes = async (runDir: string): Promise<RunTimelineMembrane[]> => {
  const raw = await readFile(path.join(runDir, "spawnfile-report.json"), "utf8").catch(() => null);
  if (raw === null) return [];
  try {
    return deriveMembranes(JSON.parse(raw));
  } catch {
    return [];
  }
};
