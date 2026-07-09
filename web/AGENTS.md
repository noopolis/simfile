# Simfile Viewer Web App

This folder contains the Vite/React viewer UI for `simfile view`.

## Structure

- `index.html` is the Vite page shell.
- `src/` contains the React app, GlyphCSS map, and UI chrome.
- `vite.config.ts` builds the app to `web/dist`, which the CLI serves.

## Rules

- Treat GlyphCSS as the map renderer and HTML as the portal renderer.
- Keep Simfile semantics out of the skin and UI. The app only consumes viewer
  APIs, ledger events, state, and skin metadata.
- Keep files under 400 lines and prefer small components when the app grows.
