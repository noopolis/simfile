import type { ReactNode } from "react";

import type { ViewerNode } from "./types.js";

export const Panel = ({ children, count, title }: {
  children: ReactNode;
  count?: ReactNode;
  title: string;
}) => (
  <section className="panel">
    <div className="panel-header">
      <span>[ {title} ]</span>
      {count !== undefined ? <span>{count}</span> : null}
    </div>
    <div className="panel-body">{children}</div>
  </section>
);

export const NodeButton = ({ active, node, onSelect }: {
  active: boolean;
  node: ViewerNode;
  onSelect: (id: string) => void;
}) => (
  <button className={active ? "active" : ""} onClick={() => onSelect(node.id)} type="button">
    <span className="row-main">
      <span className="marker">{active ? ">" : node.kind === "agent" ? "●" : "·"}</span>
      <span className="row-text">
        <span>{node.label}</span>
        <small>{node.subtitle}</small>
      </span>
    </span>
    <span className="row-trail">{node.value}</span>
  </button>
);

export const EventRow = ({ actor, detail, target, time, type }: {
  actor: string;
  detail: string;
  target: string;
  time: string;
  type: string;
}) => (
  <div className="event-row">
    <span>[{time}]</span>
    <span>[{type}]</span>
    <strong>{actor}</strong>
    <span>→</span>
    <span>{target}</span>
    <em>{detail}</em>
  </div>
);
