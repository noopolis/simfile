# Ownership Guards

This folder holds generic dependency and build-boundary checks. Keep these
checks independent of any individual simulation fixture.

- `fixtureDependencyScanner.test-helper.ts` provides the AST scanner for
  fixture-to-public-package dependencies. Keep it assertion-free,
  test-runner-free, and limited to named exports.
- `fixtureDependencyScanner.test.ts` proves the scanner fails closed for
  unsupported relative, computed, aliased, and escaped dependencies.
- `publicPackageBuildGate.test.ts` owns interruption, marker-integrity, and
  Vite-input invalidation proofs for the shared public-package build gate.

Do not add a fixture vocabulary, participant name, world identifier, or timing
constant to these generic guards. A simulation-specific ownership census or
neutrality ratchet belongs with that maintained simulation instead.
