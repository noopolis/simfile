# Observer fixtures

Recorded run evidence used by viewer and observation tests belongs here.
These are frozen test inputs, not live runs or current operating state.

- `office-sim-golden/`: canonical reconciled office simulation evidence.
- `office-world-v0-golden/`: recorded world playback trace for viewer-server tests.
- `real-grok-composed/`: recorded composed-run evidence used by timeline,
  raw-artifact, world-trace, and run-model tests.

Keep each recording's internal paths, identifiers, and artifact digests intact.
Tests reference these fixtures directly. New local runs belong under ignored
`runs/`; never add a gitignore exception to track execution output there.
