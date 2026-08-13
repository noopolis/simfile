export interface ViewerExtensionNode {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly value: string;
}

export interface ViewerExtensionSpatialObject {
  readonly id: string;
  readonly position: readonly [number, number];
  readonly velocity?: readonly [number, number];
}

export interface ViewerExtensionSpatialSample {
  readonly discontinuities?: readonly string[];
  readonly occupancy?: Readonly<Record<string, readonly string[]>>;
  readonly objects?: readonly ViewerExtensionSpatialObject[];
  readonly tick: number;
  readonly transit?: readonly unknown[];
}

export interface WorldMapRendererFrame {
  readonly nodes: readonly ViewerExtensionNode[];
  readonly onSelect: (id: string) => void;
  readonly selectedNodeId: string;
  readonly spatialSamples: readonly ViewerExtensionSpatialSample[];
  readonly tick: number;
  readonly tickDurationMs: number;
  /** Opaque data keyed by declared extension id; renderers read only their own key. */
  readonly extensionData?: unknown;
  readonly extensionIdentities?: readonly Readonly<{
    id: string;
    status: "recorded" | "unsealed/local";
  }>[];
  /** Existing replay cursor identity; extensions may join it to their opaque record. */
  readonly cursor?: Readonly<{ eventId?: string; index: number; max: number }>;
}

export interface WorldMapRendererInstance {
  fit?(): void;
  update(frame: WorldMapRendererFrame): void;
  unmount(): void;
}

/** Generic shell surfaces that a matched renderer can replace completely. */
export type ViewerPrimarySurface = "primary-metrics";

export interface WorldMapRendererDefinition {
  readonly id: string;
  /** The shell keeps every surface not explicitly owned by the matched renderer. */
  readonly ownedPrimarySurfaces?: readonly ViewerPrimarySurface[];
  /** Optional domain-owned join from an event cursor to its recorded world tick. */
  presentationTick?(frame: WorldMapRendererFrame): number | undefined;
  matches(frame: WorldMapRendererFrame): boolean;
  mount(
    host: HTMLElement,
    frame: WorldMapRendererFrame,
  ): WorldMapRendererInstance;
}

export type ActionOutcome =
  | "accepted"
  | "rejected"
  | "pending"
  | "fulfilled"
  | "expired"
  | "abandoned"
  | "matched"
  | "unmatched";

export type ActionInput = Readonly<Record<string, unknown>>;

export interface ActionFeedRow {
  readonly eventId: string;
  readonly t: number;
  readonly actId: string;
  readonly tick: number;
  readonly participant: string;
  readonly actor?: string;
  readonly verb: string;
  readonly target?: string;
  readonly input?: ActionInput;
  readonly outcome: ActionOutcome;
  readonly phase: "action" | "commitment";
  readonly commitmentId?: string;
  readonly counterparty?: string;
  readonly detail?: string;
  readonly cause?: string;
  readonly validUntilTick?: number;
  readonly sequence?: number;
}

export interface ActionLogDeclaration {
  readonly eventId: string;
  readonly t: number;
  readonly tick: number;
  readonly participant: string;
  readonly actor?: string;
  readonly verb: string;
  readonly target?: string;
  readonly input?: ActionInput;
  readonly validUntilTick?: number;
}

export interface ActionNarrationRequest {
  readonly row: ActionFeedRow;
  readonly declaration?: ActionLogDeclaration;
}

export interface ActionNarration {
  readonly text: string;
  readonly note?: string;
}

export type ActionNarrator = (
  request: ActionNarrationRequest,
) => ActionNarration | undefined;

export interface ViewerExtensionHost {
  assetRoot(extensionId: string): string;
  /** Optional only so renderer-only v1 host harnesses remain loadable. */
  registerActionNarrator?(
    extensionId: string,
    narrator: ActionNarrator,
  ): void;
  registerWorldMapRenderer(
    extensionId: string,
    renderer: WorldMapRendererDefinition,
  ): void;
}

declare global {
  var __SIMFILE_VIEWER_EXTENSION_HOST__: ViewerExtensionHost | undefined;
}

export {
  locomotionAtTick,
  spatialHeadingAtTick,
  spatialObjectAtPresentationTick,
  type ViewerExtensionLocomotion,
} from "./motion.js";
