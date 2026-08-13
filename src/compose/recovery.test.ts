import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createComposedPhaseJournal, writeComposedPhaseJournal } from "./journal.js";
import { lifecycleRequest } from "./lifecycle.test-helper.js";
import {
  ComposedRunInterruption,
  runComposedRecoveryCommand,
  runDurableComposedRun,
} from "./recovery.js";
import { composedRecoveryCommand } from "./receipt.js";
import { createComposedRunHarness } from "./run.test-helper.js";
import {
  COMPOSED_RUN_PHASES,
  composedRunPhaseIndex,
  nextComposedRunPhase,
  type ComposedRunPhase,
} from "./types.js";

const clock = () => {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 2, 1, 0, 0, tick++)).toISOString();
};

test("every durable phase interruption resumes through its exact command", async () => {
  for (const [index, phase] of COMPOSED_RUN_PHASES.entries()) {
    const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-recovery-"));
    try {
      const request = lifecycleRequest({ run_id: `run-recovery-${index}` });
      const harness = createComposedRunHarness(request);
      const journalPath = path.join(directory, "journal.json");
      const now = clock();
      let injected = false;
      const signal = index % 2 === 0 ? "SIGINT" as const : "SIGTERM" as const;
      const interrupted = await runDurableComposedRun({
        configuration: harness.configuration,
        fault_injector: {
          afterPhase: (current) => {
            if (!injected && current === phase) {
              injected = true;
              throw new ComposedRunInterruption(signal);
            }
          },
        },
        journal_path: journalPath,
        now,
        ports: harness.ports,
        request,
      });
      if (phase === "completed") {
        assert.equal(interrupted.receipt.status, "completed");
      } else {
        assert.equal(interrupted.receipt.status, "recovery_required", phase);
        assert.equal(interrupted.journal.current_phase, phase, phase);
        assert.equal(interrupted.journal.interruption?.next_phase, nextComposedRunPhase(phase));
        assert.equal(interrupted.receipt.signal, signal, phase);
        assert.equal(
          interrupted.receipt.preserved_evidence,
          composedRunPhaseIndex(phase) >= composedRunPhaseIndex("world_evidence_exported"),
          phase,
        );
        assert.equal(
          interrupted.receipt.recovery_command,
          composedRecoveryCommand(
            journalPath, interrupted.journal.request.run_id, interrupted.journal.authority_digest,
          ),
          phase,
        );
      }
      const recovered = await runComposedRecoveryCommand({
        argv: ["recover", "--journal", journalPath,
          "--run-id", interrupted.journal.request.run_id,
          "--authority-digest", interrupted.journal.authority_digest],
        configuration: harness.configuration,
        now,
        ports: harness.ports,
      });
      assert.equal(recovered.receipt.status, "completed", phase);
      assert.equal(recovered.journal.state, "complete", phase);
      assert.deepEqual(recovered.journal.entries.map((entry) => entry.phase), COMPOSED_RUN_PHASES);
      assert.equal(
        Object.values(harness.telemetry.effect_counts).every((count) => count === 1), true, phase,
      );
      assert.equal(Object.keys(harness.telemetry.effect_counts).length, 13, phase);
      assert.equal(harness.telemetry.activation_publications, 1, phase);
      assert.equal(harness.telemetry.participant_actions, 0, phase);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
});

test("an active journal from a stopped process resumes without skipping gates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-restart-"));
  try {
    const request = lifecycleRequest({ run_id: "run-process-restart" });
    const harness = createComposedRunHarness(request);
    const journalPath = path.join(directory, "journal.json");
    const initial = createComposedPhaseJournal(request, "2026-03-01T00:00:00.000Z");
    await writeComposedPhaseJournal(journalPath, initial);
    const outcome = await runComposedRecoveryCommand({
      argv: ["recover", "--journal", journalPath, "--run-id", request.run_id,
        "--authority-digest", initial.authority_digest],
      configuration: harness.configuration,
      now: clock(),
      ports: harness.ports,
    });
    assert.equal(outcome.receipt.status, "completed");
    assert.equal(outcome.journal.entries.length, COMPOSED_RUN_PHASES.length);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the process signal handler interrupts only after a persisted phase", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "simfile-composed-signal-"));
  try {
    const request = lifecycleRequest({ run_id: "run-real-signal" });
    const harness = createComposedRunHarness(request);
    let emitted = false;
    const outcome = await runDurableComposedRun({
      configuration: harness.configuration,
      fault_injector: {
        afterPhase: (phase: ComposedRunPhase) => {
          if (!emitted && phase === "prepared") {
            emitted = true;
            process.emit("SIGINT");
          }
        },
      },
      journal_path: path.join(directory, "journal.json"),
      now: clock(),
      ports: harness.ports,
      request,
    });
    assert.equal(outcome.receipt.status, "recovery_required");
    assert.equal(outcome.journal.current_phase, "prepared");
    assert.equal(outcome.receipt.signal, "SIGINT");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("the recovery command parser rejects ambiguous arguments", async () => {
  const request = lifecycleRequest();
  const harness = createComposedRunHarness(request);
  await assert.rejects(runComposedRecoveryCommand({
    argv: ["recover", "--journal", "/tmp/a", "--force"],
    configuration: harness.configuration,
    ports: harness.ports,
  }), /usage: simfile recover/u);
});
