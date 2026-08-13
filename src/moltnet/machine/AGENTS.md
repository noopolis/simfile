# Simfile Moltnet Machine Adapter

This folder owns only the lifecycle of a long-lived `moltnet machine`
subprocess. It speaks the frozen `moltnet.machine.v1` JSONL protocol through
stdio and must not contain HTTP, bearer, URL, actor, retry, cursor, fixture,
or world-specific behavior.

- `protocol.ts` validates the small enabled protocol surface (`send_nudge`,
  `read`, and `cancel`) before values reach callers.
- `client.ts` owns child-process lifecycle, bounded in-flight requests,
  backpressure, strict output handling, and cancellation forwarding.
- Tests use a fake subprocess only. A fixture may bind the generic client to
  a provider-owned executable and private config without moving provider
  semantics into Simfile.
