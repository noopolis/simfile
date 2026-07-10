# Simfile Report Helpers

This folder provides probe-evaluation utilities over ordered ledger events.
All logic is pure and testable:

- evaluate `when` expressions that are event based (including `all/any/not`);
- apply `expect` assertions (`at_least`, `at_most`, `always`, `at_end`);
- optional `after` + `within` windows are supported with deterministic timing via
  the kernel duration parser.
- evaluate social transcript acceptance; live runs require Moltnet-exported
  transcripts, while harness-derived artifacts are diagnostics only.
- `score.ts` scores a single scored-task submission from the ledger alone,
  genre-neutral: `scoreSingleSubmission(events, {actor, target, rule})` counts
  `world.act` events by `(actor, target)` and `rule.fired` events by `rule`,
  and passes iff both counts are exactly 1. No task/domain nouns — callers
  supply the actor/target/rule ids from their own fixture.
