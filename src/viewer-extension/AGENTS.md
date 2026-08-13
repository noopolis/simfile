# Viewer Extension Contracts

This folder owns the scenario-neutral extension boundary shared by run
recording and viewing. It must never contain fixture vocabulary or interpret
extension-owned data.

## Structure

- `index.ts` — public browser-facing renderer and narration contracts.
- `motion.ts` — generic spatial lookup helpers exposed through the public
  viewer-extension entry point.
- `projectDeclaration.ts` — strict project and recorded declaration parsing,
  plus binding a trusted project declaration to exact module and asset bytes.
- `descriptor.ts` — host-side descriptor loading and deterministic content
  digests for executable modules and asset trees.

## Rules

- Recorded declarations and provenance are corroborating data, never loading
  authority. Executable paths must originate in a caller-selected trusted
  project or an explicit caller argument.
- Keep extension payloads opaque and scenario-neutral.
- Reject symlinks, path escapes, malformed shapes, duplicate ids, and content
  drift rather than guessing.
- Named exports only. Keep source files under 400 lines.
