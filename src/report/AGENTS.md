# Simfile Report Helpers

This folder provides probe-evaluation utilities over ordered ledger events.
All logic is pure and testable:

- evaluate `when` expressions that are event based (including `all/any/not`);
- apply `expect` assertions (`at_least`, `at_most`, `always`, `at_end`);
- optional `after` + `within` windows are supported with deterministic timing via
  the kernel duration parser.
- evaluate social transcript acceptance; live runs require Moltnet-exported
  transcripts, while harness-derived artifacts are diagnostics only.
