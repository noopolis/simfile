# World Address Modules

This folder owns Simfile's public world-resource address boundary.

- `addresses.ts` parses authored local references and resolves them into canonical
  world addresses. Authored input stays local; only resolution emits `world://`.
- `addresses.test.ts` covers the public validation, path, collision, and isolation
  contract.
- `grants.ts` resolves checked, declared world-surface grants and binds them to
  injected, round-trippable issuer principals; it owns neither credentials nor
  bearer authentication.
- `capabilityManifest.ts` emits and parses immutable, canonical capability
  documents from B18 bound grants and callback-free checked surface metadata.
  It never invokes world-surface callbacks or exposes action ingress.
- `index.ts` is the public barrel. Consumers must import this address API through
  the barrel rather than deep-importing implementation files.

- `ledger.ts` owns the bounded, per-principal B21 read audit and hostile request
  parsing. It retains neither bearer tokens nor token digests.
- `runtime.ts` composes checked B18/B19/B20 dependencies into read operations.
  `observe.ts` and `affordances.ts` own their callback-guarded, availability-only
  read orchestration; neither owns action ingress or dynamics mutation.

- `decisionRegistry.ts` owns decision-token secrets/digests, lifecycle admission,
  first-act consumption, versioned snapshot/restore, and C/A/F closure. It does not own bearer
  authentication, grants, request idempotency, wake cadence, or mechanics.
- `decisionRegistrySnapshot.ts` is the pure snapshot clone/freeze and hostile-input
  parser boundary. It owns no live registry state, raw token, or secret key.
- `decisionRegistry.test.ts`, `decisionRegistryRestore.test.ts`, and
  `decisionRegistryReachability.test.ts` cover live behavior, hostile restore,
  and reconstructible clock/history invariants respectively.

- `act.ts` owns hostile `world.act` ingress. It reserves a decision before any
  callback, queues only host-built mechanics attempts, and commits only after a
  preallocated action-journal cell is durable in memory. Its `denyWith` choke
  point bounds every agent-visible rejection reason and optional schema path.
- `actDecisionToken.test.ts` proves decision-token refusal causes through the public `runtime.act` surface.
- `actionJournal.ts`, `actionResults.ts`, and `clockAuthority.ts` are host-only
  B22 state. They are not part of the public world barrel; the clock directly
  steps the same trusted `DynamicsSession` supplied by the Simfile host and
  immediately joins returned mechanics truth. Retaining that session handle is
  trusted-host authority, never agent authority.
- `actionJournalInspection.ts` binds issued runtimes to a host-only, read-only
  journal snapshot capability. It is intentionally absent from every public
  barrel and package export.
- `actionRefusalJournal.ts` is the host-only, drainable world-ingress refusal
  stream. It retains only tick, composed principal, closed reason/path, and an
  ordinal. Its fixed-capacity ring never hides overwrite: a reader behind an
  overwritten or otherwise unretained ordinal receives an explicit loss error.
  The journal initializes a real host tick at issuance and caches each later
  valid sample; if tick sampling fails during refusal, it records the last
  successfully sampled real tick rather than throwing or inventing a sentinel.
  It writes no files, is not checkpoint state, and is intentionally absent from
  public barrels.

- `actEnvelope.ts` is the transport-neutral canonical
  `simfile.world-act-request.v1` byte codec. It owns semantic action fields and
  request identity only; authenticated authority is never envelope data.
- `requestLedger.ts` owns request-id claims, exact canonical-byte replay, and
  prepare/commit/abort reservations. `requestLedgerSnapshot.ts` owns its
  hostile-input-safe versioned snapshot clone/parser. Neither module integrates
  `WorldRuntime.act` or exposes a mutable map, reservation, or host authority
  through a public barrel.
- `requestLedgerInspection.ts` is the host-only read-only snapshot seam for the
  private runtime request ledger. It is intentionally absent from every public
  barrel; runtime restore orchestration belongs to B24.

- `actionResult.ts` owns the frozen public terminal action-result value/parser.
  `actionResultLedger.ts` owns its private, issued principal-scoped result store
  and cursor paging; only result values and page types enter the public barrel.
  Its host reservations bind each principal to its actor and capability scope.
  Commit 2 snapshot/restore must retain the private issuer/key, bindings,
  retained per-principal entries and page/eviction frontiers, plus bounded
  admission uniqueness state, so pre-restore cursors remain valid; none become
  public or agent authority.
- `runtime.ts` owns one private result ledger per issued runtime. It reserves
  the compiled manifest principals before claiming injected authorities,
  registers only the read-only handle through the host seam, and keeps result
  admission and result-store authority off the stable six-operation surface.
- `runtime.ts` also routes every returned `world.act` ingress rejection through
  the refusal journal's single sanitizing choke point, including reentry,
  unknown-principal, and closed-ingress early returns.

Do not put dynamics identifiers or mechanics mappings in this folder. Those are a
separate internal contract.
