import type {
  ViewerTraceInspection,
  ViewerTraceInspectionSample,
} from "./types.js";

export const inspectionAtTick = (
  samples: readonly ViewerTraceInspectionSample[],
  tick: number,
  nodeId: string,
): ViewerTraceInspection | undefined => {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!;
    if (sample.tick > tick) continue;
    const inspection = sample.inspections.find((entry) => entry.node_id === nodeId);
    if (inspection !== undefined) return inspection;
  }
  return undefined;
};

/**
 * Cursor-relative fields override the latest public snapshot while stable
 * fields omitted from compact samples (for example identity/team) survive.
 */
export const inspectionSnapshotAtTick = (
  samples: readonly ViewerTraceInspectionSample[],
  tick: number,
  nodeId: string,
  fallback?: ViewerTraceInspection,
): ViewerTraceInspection | undefined => {
  const cursor = inspectionAtTick(samples, tick, nodeId);
  if (cursor === undefined) return fallback;
  const fields = new Map(
    fallback?.fields.map((field) => [field.label, field]) ?? [],
  );
  for (const field of cursor.fields) fields.set(field.label, field);
  return {
    fields: [...fields.values()],
    node_id: nodeId,
  };
};
