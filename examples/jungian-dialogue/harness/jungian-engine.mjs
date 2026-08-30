#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const valueAfter = (args, flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const postWorld = async (url, token, operation, body) => {
  const response = await fetch(`${url}/${operation}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`world ${operation} failed with ${response.status}`);
  return response.json();
};

const observeDream = async (agent) => {
  const bindings = JSON.parse(readFileSync("/spawnfile/world-bindings.json", "utf8"));
  const binding = bindings.bindings.find((entry) => entry.member.id === agent);
  const token = binding && process.env[binding.token_env];
  if (!binding || !token) throw new Error("authenticated analyst world binding is unavailable");
  const claim = await postWorld(binding.json.url, token, "claim", {
    request_id: "jungian-dialogue-opening",
    wake_id: "jungian-dialogue-schedule",
  });
  const observed = await postWorld(binding.json.url, token, "observe", {
    decision_token: claim.decision_token,
    sense: "world://dream-consulting-room/sense/dream",
  });
  const components = observed.observation?.channels?.[0]?.components;
  if (!components || typeof components !== "object") {
    throw new Error("world dream observation is incomplete");
  }
  const symbols = Object.entries(components)
    .filter(([name, weight]) => name !== "dread" && Number(weight) > 0)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([name]) => name.replaceAll("_", " "));
  if (symbols.length !== 3) throw new Error("world dream symbols are incomplete");
  return { dread: Number(components.dread), symbols };
};

const sendRoom = (cwd, text) => {
  const commandArgs = [
    "send", "--network", "dream_lab", "--target", "room:consulting-room",
    "--text", text,
  ];
  let lastError;
  for (const command of ["moltnet", "/usr/local/bin/moltnet"]) {
    try {
      execFileSync(command, commandArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error("Moltnet CLI is unavailable");
};

const claimOpening = (cwd) => {
  const marker = path.join(cwd, ".jungian-dialogue-opened");
  try { closeSync(openSync(marker, "wx")); return true; }
  catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
};

export const dreamOpeningText = ({ dread, symbols }) =>
  `DREAM-IMAGE — @daimon I dreamed of ${symbols.join(", ")}. The dread measured ${dread.toFixed(2)}. What is this image asking of me?`;

export const scriptedReply = (agent, prompt) => {
  if (agent === "analyst" && prompt.includes("STAND-BESIDE")) {
    return "Then I will not force the door. I will take the child's hand, face the mirror, and wait until the threshold can be crossed without abandonment.";
  }
  if (agent === "analyst" && prompt.includes("THRESHOLD-NOT-VERDICT")) {
    return "I am afraid that opening it will prove the mirror right: that ambition made me abandon the child in me. @daimon how do I cross without repeating that loss?";
  }
  if (agent === "daimon" && prompt.includes("I am afraid that opening it")) {
    return "STAND-BESIDE — Do not conquer the door. @analyst Stand beside the child until dread becomes attention; then the mirror can reflect a witness instead of a judge.";
  }
  if (agent === "daimon" && prompt.includes("DREAM-IMAGE")) {
    return "THRESHOLD-NOT-VERDICT — The black door is a threshold, the tarnished mirror an old judgment, and the lost child the part excluded by that judgment. @analyst Which loss are you afraid the door will repeat?";
  }
  return "";
};

export const runJungianEngine = async (args) => {
  const promptFile = valueAfter(args, "--prompt-file");
  const cwd = valueAfter(args, "--cwd") ?? process.cwd();
  const prompt = promptFile ? readFileSync(promptFile, "utf8") : "";
  const agent = path.basename(cwd);
  if (agent === "analyst" && prompt.includes("JUNGIAN-DREAM-OPEN")) {
    if (claimOpening(cwd)) {
      const dream = await observeDream(agent);
      sendRoom(cwd, dreamOpeningText(dream));
    }
    return;
  }
  const reply = scriptedReply(agent, prompt);
  if (reply) process.stdout.write(`${reply}\n`);
};

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runJungianEngine(process.argv.slice(2));
}
