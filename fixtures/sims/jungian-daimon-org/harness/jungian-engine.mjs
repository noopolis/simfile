#!/usr/bin/env node
// Deterministic canned-reply screenplay for the composed jungian-daimon-org
// sim (Piece: "descend into a mind"). Speaks the pi runtime's `scripted`
// engine argv contract (see src/runtime/pi/appCliEnginesSource.ts's
// runScriptedEngine):
//
//   node jungian-engine.mjs --prompt-file <path> --cwd <workspacePath>
//
// and prints the agent's spoken reply to stdout, which the Moltnet->Pi bridge
// auto-publishes back into the ROOM THAT WOKE THIS AGENT (publishControlResponse
// in Moltnet's bridge loop control code — a pi reply always goes
// to the originating room). That single fact is the whole reason this script
// also shells out to `moltnet send`: a self's representative is a member of TWO
// networks (its self-team's inner council AND the shared psyche floor), and the
// ONLY way it can post a message into a DIFFERENT room than the one that woke
// it — the wake-across-membranes move at the heart of this sim — is to actively
// send it via the Moltnet CLI, using the per-network credentials the compiler
// already staged in this agent's workspace `.moltnet/config.json`.
//
// The screenplay is a clean linear chain so every agent wakes exactly once:
//   operator seeds @<self>-representative in `commons` (psyche-floor)
//     -> representative posts into `<self>-council` mentioning @<self>-animus   [moltnet send -> inner network]
//        -> animus replies in the council mentioning @<self>-shadow            [auto-published reply]
//           -> shadow replies in the council mentioning the representative,
//              carrying the COUNCIL-CONCLUDED marker                            [auto-published reply]
//              -> representative (woken by that marker) posts the synthesis
//                 back into `commons`                                          [moltnet send -> psyche floor]
// selene mirrors luna's script but is never seeded by the driver, so its
// council stays dormant — proving the derivation finds a membrane the run
// never exercised, alongside the one it did.
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const COUNCIL_CONCLUDED = "COUNCIL-CONCLUDED";
const ANIMUS_HANDOFF = "hand to the shadow"; // marker only the representative's council seed carries
const SHADOW_HANDOFF = "your read, shadow";  // marker only the animus reply carries

const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt-file");
const prompt = promptIndex >= 0 ? readFileSync(args[promptIndex + 1], "utf8") : "";
const cwdIndex = args.indexOf("--cwd");
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd();
const agent = path.basename(cwd); // e.g. "luna-representative"

// self ("luna" | "selene") and role ("representative" | "animus" | "shadow").
const dash = agent.indexOf("-");
const self = dash >= 0 ? agent.slice(0, dash) : agent;
const role = dash >= 0 ? agent.slice(dash + 1) : "";
const innerNetwork = self + "_inner";
const councilRoom = self + "-council";

const log = (line) => {
  try {
    appendFileSync(path.join(cwd, "jungian-engine.log"), `${new Date().toISOString()} ${agent} ${line}\n`);
  } catch {}
};

/** Post a message into an explicit network+room via the staged Moltnet CLI,
 * using this agent's own per-network credentials (.moltnet/config.json in cwd).
 * This is the cross-membrane send the pi auto-reply cannot do. */
const moltnetSend = (network, room, text) => {
  const cliArgs = ["send", "--network", network, "--target", `room:${room}`, "--text", text];
  for (const bin of ["moltnet", "/usr/local/bin/moltnet"]) {
    try {
      const out = execFileSync(bin, cliArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      log(`moltnet send OK network=${network} room=${room} bin=${bin} out=${out.trim().slice(0, 200)}`);
      return true;
    } catch (error) {
      log(`moltnet send FAIL network=${network} room=${room} bin=${bin} err=${(error && error.message) || error} stderr=${(error && error.stderr) || ""}`);
    }
  }
  return false;
};

let reply = "";

if (role === "representative") {
  if (prompt.includes(COUNCIL_CONCLUDED)) {
    // Woken in the council by the shadow's conclusion -> answer the floor.
    moltnetSend("psyche-floor", "commons",
      `The council has spoken. ${self[0].toUpperCase()}${self.slice(1)} will meet the change with courage tempered by care.`);
    reply = ""; // nothing extra back into the council
  } else {
    // Woken in commons by the operator seed -> convene the inner council.
    moltnetSend(innerNetwork, councilRoom,
      `@${self}-animus The floor asks how ${self} should meet the coming change. Give your read, then ${ANIMUS_HANDOFF}.`);
    reply = "Consulting my inner council."; // auto-published into commons as evidence
  }
} else if (role === "animus") {
  reply = `As the animus: I see momentum and will — ${self} should step forward. @${self}-shadow, ${SHADOW_HANDOFF}: temper this.`;
} else if (role === "shadow") {
  reply = `As the shadow: I hold the fear and the cost. @${self}-representative ${COUNCIL_CONCLUDED} — proceed, but honor what it costs.`;
} else {
  reply = "";
}

process.stdout.write(reply.length > 0 ? reply + "\n" : "");
