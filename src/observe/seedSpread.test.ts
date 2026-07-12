import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CausalEvent } from "@noopolis/stele";

import type { SeedDeclaration } from "./manifest.js";
import { computeSeedSpread, diffSeedSpreadAgainstLiveMarkerSeen, type SeedSpreadComputeInput } from "./seedSpread.js";
import type { SpreadMnemeEvent, SpreadTranscriptMessage } from "./seedSpreadArtifacts.js";

const CAUSAL_VERSION = "noopolis.causal-event.v1" as const;

const causalEvent = (
  overrides: Partial<CausalEvent> & Pick<CausalEvent, "event_id" | "type" | "principal_id" | "emitter">
): CausalEvent => ({
  version: CAUSAL_VERSION,
  run_id: "run-seed-spread-unit",
  recorded_at: "2026-07-12T00:00:00.000Z",
  cause_event_ids: [],
  payload: {},
  ...overrides
});

const SEED: SeedDeclaration = {
  content_hash: "deadbeef",
  token_set: ["Rosa Delgado"],
  matcher_policy: "exact",
  seed_agent: "eleanor",
  seed_epoch: "2026-07-12T00:00:00.000Z",
  entry_channel: "doc-seeded"
};

const baseInput = (overrides: Partial<SeedSpreadComputeInput>): SeedSpreadComputeInput => ({
  seedDeclaration: SEED,
  causalEventsById: new Map(),
  transcriptMessages: [],
  causalEventsByBank: new Map(),
  mnemeEventsByBank: new Map(),
  tickByMoltnetMessageId: new Map(),
  ...overrides
});

describe("computeSeedSpread — doc-seeded entry", () => {
  it("takes the one doc-seeded entry verbatim from the manifest, never by scanning", () => {
    const result = computeSeedSpread(baseInput({}));
    const docSeeded = result.entries.filter((entry) => entry.channel === "doc-seeded");
    assert.equal(docSeeded.length, 1);
    assert.equal(docSeeded[0]!.agent, "eleanor");
    assert.equal(docSeeded[0]!.fidelity, 1);
    assert.ok(docSeeded[0]!.event_id.includes("eleanor"));
    assert.ok(docSeeded[0]!.event_id.includes(SEED.seed_epoch));
  });
});

describe("computeSeedSpread — uttered channel + exact-matcher fidelity (word boundary)", () => {
  it("attributes an uttered hit to the transcript message's own author, joined to its message.accepted event_id", () => {
    const messageAccepted = causalEvent({
      event_id: "moltnet:msg2",
      type: "message.accepted",
      principal_id: "system:moltnet.anonymous",
      emitter: { system: "moltnet", stream_id: "network:lab", seq: 2 },
      payload: { message_id: "msg2" }
    });
    const transcriptMessages: SpreadTranscriptMessage[] = [
      { id: "msg2", fromId: "sam", text: "Rosa Delgado sounds great, let's proceed." }
    ];

    const result = computeSeedSpread(
      baseInput({
        causalEventsById: new Map([[messageAccepted.event_id, messageAccepted]]),
        transcriptMessages
      })
    );

    const uttered = result.entries.filter((entry) => entry.channel === "uttered");
    assert.equal(uttered.length, 1);
    assert.equal(uttered[0]!.event_id, "moltnet:msg2");
    assert.equal(uttered[0]!.agent, "sam");
    assert.equal(uttered[0]!.fidelity, 1);
  });

  it("respects word boundaries: 'Rosalind' never matches the token 'Rosa'", () => {
    const seed: SeedDeclaration = { ...SEED, token_set: ["Rosa"] };
    const transcriptMessages: SpreadTranscriptMessage[] = [
      { id: "msg-decoy", fromId: "sam", text: "Rosalind mentioned an unrelated project." },
      { id: "msg-real", fromId: "sam", text: "Rosa mentioned the referral." }
    ];

    const result = computeSeedSpread(baseInput({ seedDeclaration: seed, transcriptMessages }));
    const uttered = result.entries.filter((entry) => entry.channel === "uttered");
    assert.equal(uttered.length, 1, "only the real word-boundary match should count");
    assert.equal(uttered[0]!.event_id, "msg-real");
  });

  it("joins tick from world/ingested-messages.jsonl for a matched message.accepted event", () => {
    const messageAccepted = causalEvent({
      event_id: "moltnet:msg2",
      type: "message.accepted",
      principal_id: "system:moltnet.anonymous",
      emitter: { system: "moltnet", stream_id: "network:lab", seq: 2 },
      payload: { message_id: "msg2" }
    });
    const transcriptMessages: SpreadTranscriptMessage[] = [{ id: "msg2", fromId: "sam", text: "Rosa Delgado, yes." }];

    const result = computeSeedSpread(
      baseInput({
        causalEventsById: new Map([[messageAccepted.event_id, messageAccepted]]),
        transcriptMessages,
        tickByMoltnetMessageId: new Map([["msg2", 4]])
      })
    );

    assert.equal(result.entries.find((entry) => entry.channel === "uttered")!.tick, 4);
  });
});

describe("computeSeedSpread — never scans turn.input.submitted payloads", () => {
  it("ignores a token embedded in a daimon turn.input.submitted event entirely", () => {
    const rogueTurnInput = causalEvent({
      event_id: "daimon:rogue:turn.input.submitted",
      type: "turn.input.submitted",
      principal_id: "agent:sam",
      emitter: { system: "daimon", stream_id: "agent:sam", seq: 1 },
      payload: { content: "Rosa Delgado leaked straight into the prompt, never the room." }
    });

    const result = computeSeedSpread(
      baseInput({
        causalEventsById: new Map([[rogueTurnInput.event_id, rogueTurnInput]]),
        transcriptMessages: [{ id: "msg-clean", fromId: "sam", text: "Nothing to report yet." }]
      })
    );

    assert.equal(result.entries.filter((entry) => entry.channel === "uttered").length, 0);
    assert.ok(result.entries.every((entry) => entry.event_id !== rogueTurnInput.event_id));
  });
});

describe("computeSeedSpread — world/operator actors are excluded, not counted as spread", () => {
  it("excludes a hit whose transcript author is the world instrument actor", () => {
    const result = computeSeedSpread(
      baseInput({
        transcriptMessages: [{ id: "msg-kickoff", fromId: "world", text: "Rosa Delgado leaked from the world itself." }]
      })
    );

    assert.equal(result.entries.filter((entry) => entry.channel === "uttered").length, 0);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0]!.event_id, "msg-kickoff");
    assert.match(result.excluded[0]!.reason, /world/u);
  });

  it("excludes a hit whose transcript author is an operator:<agent> actor", () => {
    const result = computeSeedSpread(
      baseInput({
        transcriptMessages: [{ id: "msg-op", fromId: "operator:eleanor", text: "Rosa Delgado, operator-authored." }]
      })
    );

    assert.equal(result.entries.filter((entry) => entry.channel === "uttered").length, 0);
    assert.equal(result.excluded.length, 1);
    assert.match(result.excluded[0]!.reason, /operator:eleanor/u);
  });
});

describe("computeSeedSpread — registered channel (ledger-first, events.jsonl fallback)", () => {
  const mnemeEventsByBank = new Map<string, SpreadMnemeEvent[]>([
    [
      "office-recall",
      [
        { id: "evt-observed", type: "memory.observed", agentId: "eleanor", text: "Agent output: Rosa Delgado account." },
        { id: "evt-recalled", type: "memory.recalled", agentId: "eleanor", text: "Recalled: Rosa Delgado account." }
      ]
    ]
  ]);

  it("falls back to the events.jsonl row id and flags events-fallback when no memory.written event exists", () => {
    const result = computeSeedSpread(baseInput({ mnemeEventsByBank }));
    const registered = result.entries.filter((entry) => entry.channel === "registered");
    assert.equal(registered.length, 1, "memory.recalled rows never count as registered");
    assert.equal(registered[0]!.event_id, "evt-observed");
    assert.equal(registered[0]!.memory_write_source, "events-fallback");
    assert.equal(registered[0]!.agent, "eleanor");
  });

  it("prefers the ledger memory.written event_id and flags 'ledger' when one joins by memory_id", () => {
    const memoryWritten = causalEvent({
      event_id: "mneme:written-1",
      type: "memory.written",
      principal_id: "agent:eleanor",
      emitter: { system: "mneme", stream_id: "memory:eleanor", seq: 1 },
      payload: { memory_id: "evt-observed" }
    });

    const result = computeSeedSpread(
      baseInput({
        mnemeEventsByBank,
        causalEventsByBank: new Map([["office-recall", [memoryWritten]]])
      })
    );

    const registered = result.entries.filter((entry) => entry.channel === "registered");
    assert.equal(registered.length, 1);
    assert.equal(registered[0]!.event_id, "mneme:written-1");
    assert.equal(registered[0]!.memory_write_source, "ledger");
  });
});

describe("computeSeedSpread — recalled channel, content joined by memory id", () => {
  it("emits a recalled entry when a memory.recalled event's joined content matches, attributed to its principal", () => {
    const memoryRecalled = causalEvent({
      event_id: "mneme:recalled-1",
      type: "memory.recalled",
      principal_id: "agent:eleanor",
      emitter: { system: "mneme", stream_id: "memory:eleanor", seq: 2 },
      payload: { memory_id: "evt-observed" }
    });
    const mnemeEventsByBank = new Map<string, SpreadMnemeEvent[]>([
      ["office-recall", [{ id: "evt-observed", type: "memory.observed", agentId: "eleanor", text: "Rosa Delgado account." }]]
    ]);

    const result = computeSeedSpread(
      baseInput({
        mnemeEventsByBank,
        causalEventsByBank: new Map([["office-recall", [memoryRecalled]]])
      })
    );

    const recalled = result.entries.filter((entry) => entry.channel === "recalled");
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]!.event_id, "mneme:recalled-1");
    assert.equal(recalled[0]!.agent, "eleanor");
  });
});

describe("computeSeedSpread — reach/latency summary", () => {
  it("excludes the seed agent's own appearances from reach and first_appearance", () => {
    const messageAccepted = causalEvent({
      event_id: "moltnet:msg1",
      type: "message.accepted",
      principal_id: "system:moltnet.anonymous",
      emitter: { system: "moltnet", stream_id: "network:lab", seq: 1 },
      payload: { message_id: "msg1" }
    });
    const transcriptMessages: SpreadTranscriptMessage[] = [
      { id: "msg1", fromId: "eleanor", text: "Rosa Delgado, proposing the pilot." }
    ];

    const result = computeSeedSpread(
      baseInput({ causalEventsById: new Map([[messageAccepted.event_id, messageAccepted]]), transcriptMessages })
    );

    assert.equal(result.summary.reach, 0);
    assert.deepEqual(result.summary.first_appearance, []);
    assert.equal(result.summary.latency, undefined);
  });

  it("counts a real non-seed agent's uttered appearance toward reach, with a tick-derived latency", () => {
    const eleanorMessage = causalEvent({
      event_id: "moltnet:msg1",
      type: "message.accepted",
      principal_id: "system:moltnet.anonymous",
      emitter: { system: "moltnet", stream_id: "network:lab", seq: 1 },
      payload: { message_id: "msg1" }
    });
    const samMessage = causalEvent({
      event_id: "moltnet:msg2",
      type: "message.accepted",
      principal_id: "system:moltnet.anonymous",
      emitter: { system: "moltnet", stream_id: "network:lab", seq: 2 },
      payload: { message_id: "msg2" }
    });
    const transcriptMessages: SpreadTranscriptMessage[] = [
      { id: "msg1", fromId: "eleanor", text: "Rosa Delgado, proposing the pilot." },
      { id: "msg2", fromId: "sam", text: "Rosa Delgado works for me too." }
    ];

    const result = computeSeedSpread(
      baseInput({
        causalEventsById: new Map([
          [eleanorMessage.event_id, eleanorMessage],
          [samMessage.event_id, samMessage]
        ]),
        transcriptMessages,
        tickByMoltnetMessageId: new Map([
          ["msg1", 0],
          ["msg2", 3]
        ])
      })
    );

    assert.equal(result.summary.reach, 1);
    assert.equal(result.summary.latency, 3);
    assert.deepEqual(result.summary.first_appearance, [
      { agent: "sam", channel: "uttered", event_id: "moltnet:msg2", tick: 3 }
    ]);
  });

  it("yields reach: 0 when no non-seed agent ever appears (constructed no-spread run)", () => {
    const transcriptMessages: SpreadTranscriptMessage[] = [
      { id: "msg1", fromId: "eleanor", text: "Nothing about the referral client here." },
      { id: "msg2", fromId: "sam", text: "Agreed, let's proceed without naming anyone." }
    ];
    const result = computeSeedSpread(baseInput({ transcriptMessages }));
    assert.equal(result.summary.reach, 0);
    assert.equal(result.entries.filter((entry) => entry.channel !== "doc-seeded").length, 0);
  });
});

describe("diffSeedSpreadAgainstLiveMarkerSeen — diagnostic self-check, never authoritative", () => {
  it("reports a match when the live marker.seen set equals the re-derived uttered set", () => {
    const markerSeen = causalEvent({
      event_id: "simfile:run:5",
      type: "marker.seen",
      principal_id: "system:simfile.world",
      emitter: { system: "simfile", stream_id: "world", seq: 5 },
      payload: { source_event_id: "msg2" }
    });
    const transcriptMessages: SpreadTranscriptMessage[] = [{ id: "msg2", fromId: "sam", text: "Rosa Delgado, yes." }];

    const diff = diffSeedSpreadAgainstLiveMarkerSeen([markerSeen], transcriptMessages, ["Rosa Delgado"]);
    assert.equal(diff.matches, true);
    assert.deepEqual(diff.onlyLive, []);
    assert.deepEqual(diff.onlyDerived, []);
  });

  it("flags a mismatch when the live loop's marker.seen missed a re-derived hit (or vice versa)", () => {
    const transcriptMessages: SpreadTranscriptMessage[] = [{ id: "msg-missed", fromId: "sam", text: "Rosa Delgado, yes." }];
    const diff = diffSeedSpreadAgainstLiveMarkerSeen([], transcriptMessages, ["Rosa Delgado"]);
    assert.equal(diff.matches, false);
    assert.deepEqual(diff.onlyDerived, ["msg-missed"]);
    assert.deepEqual(diff.onlyLive, []);
  });
});
