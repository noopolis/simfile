# Simfile Website Working Guide

This folder contains the public Simfile website and documentation.

## Structure

- `src/pages/index.astro` is the standalone landing page.
- `src/content/docs/` contains Starlight documentation pages.
- `src/styles/` contains landing and docs CSS.
- `src/components/` contains small Starlight overrides.
- `scripts/generate-llms-txt.mjs` emits `llms.txt` and `llms-full.txt` after build.

## Rules

- Keep this site separate from the package viewer in `../web/`.
- The site explains Simfile and links to the live viewer; it does not implement runtime UI.
- Use short, direct docs. Avoid inventing schema keys that are not in `../docs/DESIGN.md`.
- Build with `npm run build` before considering changes complete.
