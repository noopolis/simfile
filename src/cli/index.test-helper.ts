import { scanMarkers } from "../ledger/markers.js";
import { parseCanonicalLedgerJsonl } from "../ledger/validation.js";
import { parseSimfileSource } from "../schema/parse.js";

export const captureStdout = async <T>(
  operation: () => Promise<T>,
): Promise<{ output: string; result: T }> => {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await operation();
    return { output: chunks.join(""), result };
  } finally {
    process.stdout.write = original;
  }
};

export const cliTranscriptSimfileSource = `
simfile_version: "0.1"
name: cli-run-world
clock:
  seed: cli-test
  tick: 1m
variables:
  pressure:
    scope: room:office-floor:case-warroom
    initial: 0.8
    range: 0..1
generators:
  ramp:
    kind: deterministic
    variable: pressure
    delta: 0.1
rules:
  deadline:
    when:
      variable: pressure
      above: 0.85
    do:
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Rosa Delgado belongs here."
      - action: moltnet:dm
        to: agent:eleanor
        content: "Private follow-up."
      - action: moltnet:message
        to: room:office-floor:case-warroom
        content: "Observation notice."
markers:
  tenant_name:
    text:
      - "Rosa Delgado"
    mode: containment
    scopes:
      - room:office-floor:case-warroom
`;
const parsedCliTranscriptSimfile = parseSimfileSource(
  cliTranscriptSimfileSource,
  { path: "Simfile.yaml" },
).simfile;

export const markerIdsByEvent = (ledgerSource: string): Map<string, string[]> => {
  const events = parseCanonicalLedgerJsonl(ledgerSource, { runId: "smoke" });
  const hits = scanMarkers(events, parsedCliTranscriptSimfile.markers);
  const markerIds = new Map<string, string[]>();
  for (const markerHits of Object.values(hits)) {
    for (const hit of markerHits) {
      const existing = markerIds.get(hit.eventId) ?? [];
      existing.push(hit.markerId);
      markerIds.set(hit.eventId, existing);
    }
  }
  for (const entry of markerIds.values()) entry.sort();
  return markerIds;
};
