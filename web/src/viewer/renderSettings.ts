export interface RenderSettings {
  agentScale: number;
  density: number;
  roomScale: number;
  showLabels: boolean;
  wallHeightScale: number;
}

export const defaultRenderSettings: RenderSettings = {
  agentScale: 0.95,
  density: 1.2,
  roomScale: 1.42,
  showLabels: true,
  wallHeightScale: 0.92,
};
