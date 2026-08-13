import type { SimfileObserveReport } from "./report.js";

const worldGrantsSummaryLine = (report: SimfileObserveReport): string => {
  const worldGrants = report.world_grants;
  if (worldGrants === undefined) {
    return "world grants: not recorded";
  }

  const participants = worldGrants.participants.join(", ") || "none";
  const state = `resolved=${worldGrants.resolved}, observed=${worldGrants.observed}`;
  return `world grants: ${worldGrants.status} (${state}, participants: ${participants})`;
};

export const observeSummaryLines = (
  report: SimfileObserveReport,
  reportPath: string
): string[] => {
  return [
    `wrote observe report for run ${report.run_id} to ${reportPath}`,
    `participants: ${report.participants.join(", ")}`,
    `agent turns: ${report.agent_turns.count} (${report.agent_turns.sequence.join(" -> ")})`,
    `chains: ${report.chains.complete} complete, ${report.chains.incomplete.length} incomplete`,
    `failures: ${report.failures.length}`,
    worldGrantsSummaryLine(report)
  ];
};
