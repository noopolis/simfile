import { inspectionSnapshotAtTick } from "./inspectionModel.js";
import { spatialObjectAtTick } from "./spatialObjectModel.js";
import type {
  ViewerNode,
  ViewerSpatialSample,
  ViewerTraceInspection,
  ViewerTraceInspectionSample,
} from "./types.js";

interface WorldHudProps {
  inspectionsByNode: Readonly<Record<string, ViewerTraceInspection>>;
  inspectionSamples: readonly ViewerTraceInspectionSample[];
  nodes: readonly ViewerNode[];
  onSelect: (id: string) => void;
  selectedNodeId: string;
  spatialSamples: readonly ViewerSpatialSample[];
  tick: number;
}

const unavailable = "unavailable";

export function WorldHud({
  inspectionsByNode,
  inspectionSamples,
  nodes,
  onSelect,
  selectedNodeId,
  spatialSamples,
  tick,
}: WorldHudProps) {
  const agents = nodes.filter((node) => node.kind === "agent");
  const publicSignals = nodes.filter((node) => node.kind === "variable").slice(0, 3);

  if (agents.length === 0 && publicSignals.length === 0) return null;

  return (
    <section className="world-hud" aria-label="Public world state">
      <header>
        <span>PUBLIC WORLD STATE</span>
        <span>tick {tick}</span>
        {publicSignals.map((signal) => (
          <strong key={signal.id}>
            {signal.label} <b>{signal.value}</b>
          </strong>
        ))}
      </header>
      <div className="world-hud-agents">
        {agents.map((agent) => {
          const object = spatialObjectAtTick(spatialSamples, tick, agent.id);
          const inspection = inspectionSnapshotAtTick(
            inspectionSamples,
            tick,
            agent.id,
            inspectionsByNode[agent.id],
          );
          const hasBodyController = fieldValue(inspection, "body skill") !== unavailable
            || fieldValue(inspection, "strategy") !== unavailable;
          return (
            <button
              aria-label={`Inspect ${agent.label}`}
              aria-pressed={selectedNodeId === agent.id}
              className={selectedNodeId === agent.id ? "selected" : ""}
              key={agent.id}
              onClick={() => onSelect(agent.id)}
              type="button"
            >
              <span className="world-hud-agent-title">
                <i aria-hidden="true" />
                <strong>{agent.label}</strong>
                <small>{fieldValue(inspection, "team")}</small>
              </span>
              <span>
                <small>position</small>
                <b>{formatVector(object?.position)}</b>
              </span>
              <span>
                <small>{hasBodyController ? "strategy" : "decision"}</small>
                <b>{fieldValue(inspection, hasBodyController ? "strategy" : "decision")}</b>
              </span>
              <span>
                <small>{hasBodyController ? "body" : "action"}</small>
                <b>{fieldValue(inspection, hasBodyController ? "body skill" : "action")}</b>
              </span>
              <span>
                <small>{hasBodyController ? "outcome" : "result"}</small>
                <b>{fieldValue(inspection, hasBodyController ? "controller outcome" : "result")}</b>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

const fieldValue = (
  inspection: ViewerTraceInspection | undefined,
  label: string,
): string =>
  inspection?.fields.find((field) => field.label === label)?.value ?? unavailable;

const formatVector = (vector: readonly number[] | undefined): string =>
  vector?.map((value) => value.toFixed(2)).join(", ") ?? unavailable;
