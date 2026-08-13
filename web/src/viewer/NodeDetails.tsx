import { inspectionSnapshotAtTick } from "./inspectionModel.js";
import { spatialObjectAtTick } from "./spatialObjectModel.js";
import type {
  ViewerNode,
  ViewerSpatialSample,
  ViewerTraceInspection,
  ViewerTraceInspectionSample,
} from "./types.js";

interface NodeDetailsProps {
  inspection?: ViewerTraceInspection;
  inspectionSamples: readonly ViewerTraceInspectionSample[];
  node: ViewerNode;
  spatialSamples: readonly ViewerSpatialSample[];
  tick: number;
}

const unavailable = "unavailable";

export function NodeDetails({
  inspection,
  inspectionSamples,
  node,
  spatialSamples,
  tick,
}: NodeDetailsProps) {
  const object = spatialObjectAtTick(spatialSamples, tick, node.id);
  const cursorInspection = inspectionSnapshotAtTick(
    inspectionSamples,
    tick,
    node.id,
    inspection,
  );
  const position = object?.position.map((value) => value.toFixed(3)).join(", ") ?? unavailable;
  const velocity = object?.velocity?.map((value) => value.toFixed(3)).join(", ") ?? unavailable;
  return (
    <>
      <div className="detail-head">
        <p>{node.label}</p>
        <span>{node.value}</span>
      </div>
      <DetailRow label="scope" value={node.scope} />
      <DetailRow label="status" value={node.subtitle} />
      <DetailRow label="position" value={position} />
      <DetailRow label="velocity" value={velocity} />
      {(cursorInspection?.fields ?? []).map((field) => (
        <DetailRow key={field.label} label={field.label} value={field.value} />
      ))}
      <p className="detail-copy">{node.detail}</p>
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label} :</span>
      <span>{value}</span>
    </div>
  );
}
