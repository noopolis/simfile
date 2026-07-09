# Simfile Viewer Runtime

This folder contains the minimal `simfile view` implementation used to serve the
web skeleton locally.

## Structure

- `index.ts` parses `simfile view` CLI arguments and launches the server.
- `server.ts` hosts static files from `../web` and provides read-only JSON/SSE
  endpoints.

## Rules

- Keep command parsing small and deterministic.
- Keep the served surface intentionally minimal; this folder is the scaffold for
  the live-first viewer and not the full production viewer.
- Named exports only.
- Files stay concise so they stay easy to iterate on.
