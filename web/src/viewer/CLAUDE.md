# Simfile Viewer

This folder contains the browser UI for replaying Simfile run records.

## Structure

- `App.tsx` owns data loading, stream subscription, selection state, and the console shell.
- `worldModel.ts` converts the generated `viewer-trace.json` contract into render-ready nodes, rooms, paths, and event rows.
- `tileWorld.ts` derives a viewer-owned tile/glyph world model from run artifacts so presentation can stay separate from the data.
- `AsciiMap.tsx` renders the default replay console surface: a dense ASCII/tile map with room, corridor, signal, and agent layers.
- `SceneMap.tsx`, `SceneGeometry.tsx`, `SceneLabels.tsx`, `CameraFocus.tsx`, and `sceneMotion.ts` are retained while the console transitions away from the pseudo-3D surface.
- `RenderSettingsPanel.tsx` and `renderSettings.ts` define runtime visual controls.
- `types.ts` is the shared contract between the viewer server, trace artifact, and React components.

## Constraints

- Do not add Simfile authoring keys for presentation. Viewer skins and layout are derived from run artifacts or viewer-owned configuration.
- Replay mode must render the run trace it was given. Do not silently fall back to demo data when `/api/world` is unavailable.
- Heuristic agents may be listed in the inspector, but they are not rendered as room bodies unless the trace has presence events for them.
- Keep the tile world data-first. The flat console is the first presentation of that model, not the only possible renderer.
- Keep components focused and split before files approach 400 lines.
