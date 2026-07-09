---
title: Live Viewer
description: Run and inspect the Simfile viewer.
---

The viewer is shipped inside the `simfile` npm package. It is not the public website. It is the local operator interface for a running or recorded simulation.

```bash
simfile view --state .sim --port 18787
```

The command starts a small local server with the current viewer surface:

- a dense ASCII/tile replay console,
- a viewer-owned glyph map of rooms, corridors, agents, and signals,
- an event stream with live heartbeat events,
- API endpoints for state and skin metadata.

The console presentation is not a Simfile authoring key. It is a default viewer skin over public run artifacts, and the same tile world can later be rendered in other surfaces.

## Current Endpoints

```text
GET /api/state
GET /api/skins
GET /api/events
```

The event stream is designed for live runs. Recorded runs can be replayed by driving the same viewer state from a run directory.

## Viewer Boundary

The viewer consumes public artifacts: state files, run records, ledgers, and exports. If the viewer needs private runtime data, the ledger or export contract is missing something.

This keeps the UI useful for local debugging and later hosted dashboards.
