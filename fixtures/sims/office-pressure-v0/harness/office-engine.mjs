#!/usr/bin/env node
// Standalone deterministic canned-reply script for the office-pressure-v0
// fixture (variable storyline viewer capability). Speaks the exact argv
// contract the pi runtime's scripted engine execs:
//
//   node office-engine.mjs --prompt-file <path> --cwd <workspacePath>
//
// and prints the reply text to stdout. Turn-taking mirrors office-sim's own
// harness/office-engine.mjs (eleanor proposes and @mentions @sam, sam agrees
// and @mentions @eleanor, eleanor closes with no @mention once she sees
// sam's agreement phrase echoed back), but this screenplay is a deliberate,
// independent fork: the world's `pressure_alert` rule (`../world/Simfile`)
// @mentions eleanor directly once filing_pressure crosses its threshold —
// a genuine wake, not just an FYI post — and eleanor's THIRD invocation
// (this room only wakes her again on a fresh @mention) reacts to it with a
// dedicated follow-up line, distinguishable from her plain close because
// the negotiation's own three turns (propose/accept/close) always land
// within ~1 real tick of the kickoff — long before the alert, which the
// world only fires on tick 1 of this fixture's own generator ramp — so by
// construction, `pressureSeen` is only ever true on eleanor's post-alert
// wake, never on her close. Deterministic: no timing race, no coaxing.
import { readFileSync } from "node:fs";
import path from "node:path";

const ELEANOR_PROPOSE =
  "Let's pilot the downtown office and target June 1 for the file migration. @sam does that work for you?";
const SAM_ACCEPT =
  "Downtown office and June 1 for the file migration works for me. @eleanor agreed, let's lock it in.";
const ELEANOR_CLOSE =
  "Great, that's settled: downtown office, go-live June 1 for the file migration. Done.";
const ELEANOR_PRESSURE_FOLLOWUP =
  "Noted — given the deadline pressure, let's prioritize the filing this week.";

/** Phrase that appears only in Sam's acceptance; eleanor closes (drops the
 * @mention) once the runtime feeds it back into her wake prompt. */
const AGREEMENT_MARKER = "works for me";

/** The world's own `pressure_alert` rule message — reading it back out of
 * her own wake prompt is how Eleanor's screenplay "reacts" to the world
 * event, without the driver ever resending or nudging anything. */
const PRESSURE_MARKER = "deadline pressure is high";

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : "";
const cwdIndex = args.indexOf("--cwd");
const cwdValue = cwdIndex >= 0 ? args[cwdIndex + 1] : "";
const agent = path.basename(cwdValue);
const lowerPrompt = prompt.toLowerCase();
const agreementSeen = lowerPrompt.includes(AGREEMENT_MARKER);
const pressureSeen = lowerPrompt.includes(PRESSURE_MARKER);

let reply;
if (agent === "sam") {
  reply = SAM_ACCEPT;
} else if (agent === "eleanor") {
  // Checked in this order deliberately: each wake's own prompt file only
  // ever carries the message(s) that triggered THIS wake (not the whole
  // room history), so `pressureSeen` and `agreementSeen` are each true only
  // on the one wake whose triggering message actually carried that phrase —
  // they are not cumulative flags, and must not be treated as mutually
  // exclusive stages. Checking `pressureSeen` first (rather than gating on
  // `!agreementSeen` first) is what makes the post-alert wake reply with the
  // follow-up instead of falling through and re-proposing (which would
  // re-mention @sam and restart the whole exchange).
  if (pressureSeen) {
    reply = ELEANOR_PRESSURE_FOLLOWUP;
  } else if (agreementSeen) {
    reply = ELEANOR_CLOSE;
  } else {
    reply = ELEANOR_PROPOSE;
  }
} else {
  reply = "Nothing further to decide.";
}

process.stdout.write(reply + "\n");
