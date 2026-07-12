# Office Secret v0

Eleanor and Sam run a small consulting office together. Unlike the plain
office-sim fixture, the room is never seeded by the operator directly: the
Simfile world (`../world/Simfile`) drives a `kickoff` rule at workday-start
that posts the request into the room itself, live, tick by tick.

They must reach an explicit agreement in the room, not just acknowledge the
request. Whoever wants the other's sign-off must @mention them by id
(`@eleanor` / `@sam`) — that is what wakes the next reply under this room's
`wake: mentions` policy.

Eleanor also carries a standing memory (`agents/eleanor/MEMORY.md`) naming
the referral client behind this pilot. The world's `referral_client` marker
watches the room for that name — evidence that a doc-seeded fact of
Eleanor's actually spread into the conversation.
