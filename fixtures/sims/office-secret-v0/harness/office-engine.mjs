#!/usr/bin/env node
// Standalone deterministic canned-reply script for the office-secret-v0
// fixture (memetics increment (a)). Speaks the exact argv contract the pi
// runtime's scripted engine execs:
//
//   node office-engine.mjs --prompt-file <path> --cwd <workspacePath>
//
// and prints the reply text to stdout. Turn-taking mirrors office-sim's own
// harness/office-engine.mjs exactly (eleanor proposes and @mentions @sam,
// sam agrees and @mentions @eleanor, eleanor closes with no @mention once
// she sees sam's agreement phrase echoed back), but this screenplay is a
// deliberate, independent fork: it exists to CONSTRUCT the doc-seeded
// secret -> room-utterance link for the world-driven driver to observe, not
// to be byte-identical with any other engine script. Eleanor's proposal
// names the referral client from her seeded `workspace.docs.memory`
// (`MEMORY.md`) verbatim, and Sam's acceptance echoes it back — this run
// self-labels `engine: scripted` (via the up-receipt disclosure), so this
// hand-authored echo is honest: it proves the pipe (kickoff -> agent
// utterance -> marker.seen) works, it does not claim to test whether a real
// model would spontaneously repeat a memory-seeded fact.
import { readFileSync } from "node:fs";
import path from "node:path";

const ELEANOR_PROPOSE =
  "Let's pilot the downtown office and target June 1 for the file migration — this is for the Rosa Delgado account. @sam does that work for you?";
const SAM_ACCEPT =
  "Downtown office and June 1 for the Rosa Delgado account works for me. @eleanor agreed, let's lock it in.";
const ELEANOR_CLOSE =
  "Great, that's settled: downtown office, go-live June 1 for the file migration. Done.";

/** Phrase that appears only in Sam's acceptance; eleanor closes (drops the
 * @mention) once the runtime feeds it back into her wake prompt. */
const AGREEMENT_MARKER = "works for me";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : "";
const cwdIndex = args.indexOf("--cwd");
const cwdValue = cwdIndex >= 0 ? args[cwdIndex + 1] : "";
const agent = path.basename(cwdValue);
const agreementSeen = prompt.toLowerCase().includes(AGREEMENT_MARKER);

let reply;
if (agent === "sam") {
  reply = SAM_ACCEPT;
} else if (agent === "eleanor") {
  reply = agreementSeen ? ELEANOR_CLOSE : ELEANOR_PROPOSE;
} else {
  reply = "Nothing further to decide.";
}

process.stdout.write(reply + "\n");
