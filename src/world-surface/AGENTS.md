# World Surface Authoring Boundary

This folder owns the genre-neutral authored `simfile.world-surface.v1`
contract. World modules may declare public entities, senses, affordances,
effects, and bounded schemas here while keeping mechanics in
`DynamicsProvider`.

## Files

- `types.ts` defines the public synchronous authoring contract.
- `definition.ts` validates authored declarations, creates checked registries,
  and attests only registries returned by the public parser.
- `invoke.ts` guards callback invocation without exposing authored callbacks.
- `authority.ts` centralizes reserved host-envelope field rejection.
- `observation.ts` validates bounded public numeric observations.
- `recommendation.ts` pins the metadata-only observation recommendation
  channel; it admits no wake, recipient, delivery, request, or authority data.
- `own-data.ts` constructs stable null-prototype checked JSON records.
- `schema.ts` validates the deliberately small, bounded JSON Schema 2020-12
  subset used for action inputs and effect payloads.
- `schema-value.ts` applies parsed bounded schemas to checked JSON values.
- `schema-value.test.ts` covers bounded validation-rejection detail transport,
  including caller-authored unknown-property containment.
- `rejection.ts` owns the closed ingress-rejection vocabulary and the bounded,
  schema-path-only action-input validation error transport.
- `synchrony.ts` validates callback declarations and returns through bounded
  descriptor/prototype inspection without executing accessors.
- `schema-prototype.test.ts` and `observation-authority-prototype.test.ts`
  guard inherited-key, later-prototype-mutation, and authority regressions.
- `index.ts` is the public barrel.

## Constraints

- Reuse the local-reference grammar from `src/world/addresses.ts`; do not
  normalize or invent another address syntax.
- Authored callbacks are trusted in-process functions, not sandboxed code.
  Runtime callers clone and freeze inputs, reject asynchronous returns, and
  validate outputs; authors remain responsible for callback purity. These
  guards constrain the authoring boundary and are not a security sandbox
  against environment, filesystem, network, clock, or randomness access.
- Schemas are closed and locally self-contained. Reject references,
  executable/default/format behavior, unknown keywords, unsafe keys, and
  declarations that do not prove finite bounds under `DYNAMICS_LIMITS`.
- Keep mechanics, grants, authentication, runtime registries, receipt
  authority, and protocol adapters outside this folder.
- Keep files below 400 lines, use named exports, and colocate tests.
