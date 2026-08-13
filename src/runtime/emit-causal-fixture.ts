import { parseSimfileSource } from "../schema/parse.js";
import { buildCausalFixtureRecords } from "./causal-fixture.js";
import { runSimfileTrace } from "./trace-run.js";

/**
 * B92's entry point into simfile: root's conformance harness shells out to
 * `npm run emit-causal-fixture` and validates each printed line against
 * `specs/causal-event.v1.schema.json` plus payload minimums. Keep stdout
 * pure JSONL — one noopolis.causal-event.v1 record per line, no banner, no
 * other console output.
 */
const FIXTURE_SOURCE = `
simfile_version: "0.1"
name: causal-fixture-world
clock:
  seed: causal-fixture
  tick: 1m
rules:
  announce:
    fire: once
    when:
      event: clock.sync
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "causal fixture message"
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Observation notice."
`;

export const emitCausalFixtureJsonl = (): string[] => {
  const runId = process.env.NOOPOLIS_RUN_ID ?? "simfile-fixture-run";
  const { simfile } = parseSimfileSource(FIXTURE_SOURCE, { path: "causal-fixture.yaml" });
  const trace = runSimfileTrace(simfile, { runId, seed: "causal-fixture-seed", ticks: 2 });
  return buildCausalFixtureRecords(trace.events).map((record) => JSON.stringify(record));
};

/* c8 ignore start -- thin stdout entry point, exercised via emitCausalFixtureJsonl in tests */
const isMainModule = (): boolean => {
  const entry = process.argv[1];
  return typeof entry === "string" && import.meta.url === new URL(`file://${entry}`).href;
};

if (isMainModule()) {
  for (const line of emitCausalFixtureJsonl()) {
    process.stdout.write(`${line}\n`);
  }
}
/* c8 ignore stop */
