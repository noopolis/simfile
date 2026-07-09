import { useEffect, useRef, useState } from "react";

import type { RenderSettings } from "./renderSettings.js";

interface RenderSettingsPanelProps {
  onChange: (settings: RenderSettings) => void;
  settings: RenderSettings;
}

const controls: Array<{
  key: keyof Omit<RenderSettings, "density" | "showLabels">;
  label: string;
  max: number;
  min: number;
  step: number;
}> = [
  { key: "roomScale", label: "room spread", max: 1.9, min: 0.9, step: 0.05 },
  { key: "agentScale", label: "glyph scale", max: 1.4, min: 0.7, step: 0.05 },
  { key: "wallHeightScale", label: "terrain mix", max: 1.3, min: 0.45, step: 0.05 },
];

export function RenderSettingsPanel({ onChange, settings }: RenderSettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const frameRef = useRef<number | null>(null);
  const latestDraftRef = useRef(settings);

  useEffect(() => {
    setDraft(settings);
    latestDraftRef.current = settings;
  }, [settings]);

  useEffect(() => () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
    }
  }, []);

  const updateNumber = (key: keyof Omit<RenderSettings, "showLabels">, value: string) => {
    updateDraft({ ...latestDraftRef.current, [key]: Number(value) });
  };
  const updateDraft = (next: RenderSettings) => {
    latestDraftRef.current = next;
    setDraft(next);
    if (frameRef.current !== null) {
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      onChange(latestDraftRef.current);
    });
  };

  return (
    <div className="render-settings">
      <label className="density-row">
        <span>tile density</span>
        <input
          max={1.8}
          min={0.7}
          onChange={(event) => updateNumber("density", event.target.value)}
          step={0.1}
          type="range"
          value={draft.density}
        />
        <output>{draft.density.toFixed(1)}x</output>
      </label>
      {controls.map((control) => (
        <label key={control.key}>
          <span>{control.label}</span>
          <input
            max={control.max}
            min={control.min}
            onChange={(event) => updateNumber(control.key, event.target.value)}
            step={control.step}
            type="range"
            value={draft[control.key]}
          />
          <output>{formatValue(draft[control.key])}</output>
        </label>
      ))}
      <p>Presentation-only controls for the replay console. They tune the tile pass, never the Simfile schema.</p>
      <label className="toggle-row">
        <span>labels</span>
        <input
          checked={draft.showLabels}
          onChange={(event) => updateDraft({ ...latestDraftRef.current, showLabels: event.target.checked })}
          type="checkbox"
        />
      </label>
    </div>
  );
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
