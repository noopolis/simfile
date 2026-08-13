/*
 * Simfile causal-envelope principal decision record (D1-D4).
 *
 * D1. The wire grammar remains closed at `^(?:agent|operator|system):.+`.
 * These prefixes are trust classes, not producer names, so adding a
 * `controller:` kind would widen a cross-repository contract for an identity
 * that already belongs to the trusted `system:` class. Producer identity
 * remains in `emitter.system`.
 *
 * D2. A simfile controller is encoded as
 * `system:simfile.controller.<controller_id>`. The controller id is appended
 * verbatim, rather than hex-, percent-, or otherwise escaped, because string
 * concatenation and a fixed prefix-strip are injective over JavaScript UTF-16
 * code-unit sequences, including lone surrogates, which JSON stringify/parse
 * also preserves. This keeps the reconciled ledger human-readable while
 * making distinct controller identities recoverable from the envelope alone.
 * Stele must not invent edges and this design means it never has to.
 *
 * D3. Origin determines the namespace. Agentic attempts use the agent trust
 * class when their principal is bare; controllers always use the recoverable
 * simfile controller namespace; external and replay attempts use their own
 * simfile namespaces only when bare. External and replay must preserve an
 * already-grammatical principal verbatim so replayed envelopes retain the
 * principal identity of the original event.
 *
 * D4. Cause ids have the form `<namespace>:<local>`. Foreign namespaces are
 * legal. Bare ids are nonconforming, but validation must never discard the
 * carrying event merely because a cause id is bare. Principal resolution does
 * not alter that independent cause-id rule.
 */

import type { DynamicsActionAttempt } from "../dynamics/types.js";

export const SIMFILE_PRINCIPAL_GRAMMAR = /^(?:agent|operator|system):.+/u;

export const SIMFILE_CONTROLLER_PRINCIPAL_PREFIX =
  "system:simfile.controller.";

const isGrammaticalPrincipal = (principal: string): boolean =>
  SIMFILE_PRINCIPAL_GRAMMAR.test(principal);

/* Total strip: non-prefixed input is used whole, so both forms denote one id. */
const stripLeadingControllerKind = (principalId: string): string =>
  principalId.startsWith("controller:")
    ? principalId.slice("controller:".length)
    : principalId;

export const resolveCausalPrincipal = (input: Readonly<{
  origin: DynamicsActionAttempt["origin"];
  principalId: string;
}>): string => {
  const { origin, principalId } = input;
  switch (origin) {
    case "agentic":
      return isGrammaticalPrincipal(principalId)
        ? principalId
        : `agent:${principalId}`;
    case "controller":
      /*
       * There is deliberately no grammatical-passthrough branch here. The
       * controller lane (`src/world/controllerAuthority.ts:125`) always mints
       * `controller:<controller_id>`, and routing it through the
       * `system:simfile.controller.` prefix makes the identity recoverable by
       * a fixed prefix-strip. This strip is total: a value that does not start
       * with `controller:` is used whole, so `controller:x` and `x` denote the
       * same controller.
       */
      return `${SIMFILE_CONTROLLER_PRINCIPAL_PREFIX}${stripLeadingControllerKind(principalId)}`;
    case "external":
      /*
       * External and replay preserve an already-grammatical principal
       * verbatim. This is load-bearing for replay: a replayed `agent:nora`
       * must remain `agent:nora`, or its ledger would not match the original.
       */
      return isGrammaticalPrincipal(principalId)
        ? principalId
        : `system:simfile.external.${principalId}`;
    case "replay":
      /*
       * Replay likewise preserves an already-grammatical principal verbatim;
       * a replayed `agent:nora` must remain `agent:nora` so the replay ledger
       * matches the original it replays.
       */
      return isGrammaticalPrincipal(principalId)
        ? principalId
        : `system:simfile.replay.${principalId}`;
  }
  const exhaustiveOrigin: never = origin;
  return exhaustiveOrigin;
};

export const readControllerPrincipalId = (
  principal: string
): string | undefined => principal.startsWith(SIMFILE_CONTROLLER_PRINCIPAL_PREFIX)
  ? principal.slice(SIMFILE_CONTROLLER_PRINCIPAL_PREFIX.length)
  : undefined;
