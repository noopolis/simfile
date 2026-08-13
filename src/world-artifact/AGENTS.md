# World Artifact Guide

This folder owns the provider-neutral, content-addressed closure for the
generic Simfile world service.

- It names one unbound service factory; deployment owns servers, sockets, and
  process lifecycle.
- It may inspect only production source and emitted modules beneath the supplied
  roots. It never starts a world, reads credentials, or resolves an image.
- Keep the manifest canonical, bounded, and independent of host paths and time.
- `authoring.ts` owns the genre-neutral project binding and the composed
  authored-grant/principal/capability-manifest compiler.
- `composerBuild.ts` snapshots and bundles the binding-selected project
  composer while recording its exact source/config/tool provenance.
- `prepare.ts` is the build-only provider/artifact/composer/bundle operation;
  it never starts services or resolves deployment targets.
- `preparedBundleCache.ts` hashes declared source/config inputs and validates
  every byte of a cached runnable bundle before reuse.
- The artifact consumes the frozen Tiny Football production descriptor only to
  assert generic contract identity; it contains no fixture behavior.
- `readiness.ts` owns the strict, secret-free, paused-world projection exposed
  to a public Spawnfile query. It cannot represent organization readiness.
- `clockObservation.ts` owns the strict post-activation world-clock projection;
  it reports observed progress and action count without advancing the clock.
- `entrypoint.ts` is the thin public composition surface for the runnable
  sidecar entrypoint.
- `worldServiceConstruction.ts` builds the bound generic world service from a
  prepared bundle without owning transport or process lifecycle.
- `sidecarConfiguration.ts` parses and validates sidecar environment inputs.
- `sidecarReadiness.ts` owns readiness-file publication and readiness polling.
- `sidecarEntrypoint.ts` owns sidecar startup, shutdown, and process signals.
