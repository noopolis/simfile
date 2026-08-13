import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createComposedPhaseJournal, markComposedJournalRecoverable, writeComposedPhaseJournal } from "./journal.js";
import { createComposedJournalSession, openComposedJournalSession } from "./journalSession.js";
import { lifecycleDigest, lifecycleRequest } from "./lifecycle.test-helper.js";
import { composedRecoveryCommand } from "./receipt.js";

const expected = (journal: ReturnType<typeof createComposedPhaseJournal>) => ({
  authority_digest: journal.authority_digest,
  run_id: journal.request.run_id,
});

test("journal sessions pin identity and compare the exact prior generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-journal-session-"));
  try {
    const target = path.join(root, "journal.json");
    const initial = createComposedPhaseJournal(lifecycleRequest({ run_id: "run-session" }),
      "2026-08-07T00:00:00.000Z");
    const session = await createComposedJournalSession(target, initial);
    const next = markComposedJournalRecoverable(initial, {
      recovery_command: composedRecoveryCommand(
        target, initial.request.run_id, initial.authority_digest,
      ), signal: "failure",
    });
    await session.replace(initial, next);
    assert.deepEqual(session.current(), next);
    await session.assertCurrent(next);
    await writeComposedPhaseJournal(target, next);
    await assert.rejects(session.assertCurrent(), /identity changed/u);

    const link = path.join(root, "journal-link.json");
    await symlink(target, link);
    await assert.rejects(openComposedJournalSession(link, expected(initial)), /unsafe/u);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("journal replacement never overwrites a hostile intervening generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-journal-race-"));
  try {
    const target = path.join(root, "journal.json");
    const initial = createComposedPhaseJournal(lifecycleRequest({ run_id: "run-owned" }),
      "2026-08-07T00:00:00.000Z");
    const foreign = createComposedPhaseJournal(lifecycleRequest({ run_id: "run-foreign" }),
      "2026-08-07T00:00:00.000Z");
    const session = await createComposedJournalSession(target, initial, {
      beforeReplaceCommit: () => writeComposedPhaseJournal(target, foreign),
    });
    const next = markComposedJournalRecoverable(initial, {
      recovery_command: composedRecoveryCommand(
        target, initial.request.run_id, initial.authority_digest,
      ), signal: "failure",
    });
    await assert.rejects(session.replace(initial, next), /identity changed/u);
    assert.match(await readFile(target, "utf8"), /run-foreign/u);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("opening a journal requires its exact run and immutable genesis authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "simfile-journal-authority-"));
  try {
    const target = path.join(root, "journal.json");
    const owned = createComposedPhaseJournal(lifecycleRequest({ run_id: "run-owned" }),
      "2026-08-07T00:00:00.000Z");
    await writeComposedPhaseJournal(target, owned);
    assert.deepEqual((await openComposedJournalSession(target, expected(owned))).current(), owned);
    for (const foreign of [
      createComposedPhaseJournal(lifecycleRequest({ run_id: "run-foreign" }),
        "2026-08-07T00:00:00.000Z"),
      createComposedPhaseJournal(lifecycleRequest({ run_id: "run-owned" }),
        "2026-08-07T00:00:00.000Z"),
      createComposedPhaseJournal(lifecycleRequest({ run_id: "run-owned",
        descriptor_digest: lifecycleDigest("9") }), "2026-08-07T00:00:00.000Z"),
    ]) {
      await writeComposedPhaseJournal(target, foreign);
      await assert.rejects(openComposedJournalSession(target, expected(owned)), /authority changed/u);
    }
  } finally { await rm(root, { force: true, recursive: true }); }
});
