import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createComposedPhaseJournal, writeComposedPhaseJournal } from "../compose/journal.js";
import { digestComposedJson } from "../compose/json.js";
import { lifecycleOrganizationUpReceipt, lifecyclePreparation, lifecycleReadiness, lifecycleRequest } from "../compose/lifecycle.test-helper.js";
import { createComposedRunHarness } from "../compose/run.test-helper.js";
import { composedRecoveryCommand } from "../compose/receipt.js";
import { ensurePublicPackageBuild } from "../publicPackageBuild.test-helper.js";
import { builtRecoveryEffectCount, builtRecoveryProviderCommand, createForeignExecutionJournal, expectBuiltForeignJournalRejections, expectBuiltRecoveryArgumentRejections, expectBuiltRecoveryAuthorityFailure, failedBuiltRecovery, organizationExport, type BuiltRecovery } from "./recoverAuthority.test-helper.js";

const execute = promisify(execFile);
const fixtureScript = (fixed: unknown): string => `#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
const fixed=${JSON.stringify(fixed)};
const argv=process.argv.slice(2);
fs.appendFileSync(fixed.logPath,JSON.stringify(argv)+"\\n");
const canonical=(v)=>Array.isArray(v)?"["+v.map(canonical).join(",")+"]":v!==null&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}":JSON.stringify(v);
const digest=(domain,v)=>"sha256:"+crypto.createHash("sha256").update(domain+"\\0").update(canonical(v)).digest("hex");
const seal=(domain,body)=>({...body,receipt_digest:digest(domain,body)});
const output=(value)=>process.stdout.write(canonical(value));
const crashWindow=(command,key)=>{
  if(fs.existsSync(fixed.beforeCrash)&&fs.readFileSync(fixed.beforeCrash,"utf8").trim()===command){fs.unlinkSync(fixed.beforeCrash);process.exit(86);}
  const effects=fs.existsSync(fixed.effectState)?JSON.parse(fs.readFileSync(fixed.effectState,"utf8")):{};
  effects[command+":"+key]??=1;
  fs.writeFileSync(fixed.effectState,JSON.stringify(effects));
  if(fs.existsSync(fixed.swapAfter)) {
    const [mode,wanted]=fs.readFileSync(fixed.swapAfter,"utf8").trim().split(":");
    if(wanted===command){fs.unlinkSync(fixed.swapAfter);if(mode==="symlink"){fs.unlinkSync(fixed.journalPath);fs.symlinkSync(fixed.foreignJournal,fixed.journalPath);}else fs.renameSync(fixed.foreignJournal,fixed.journalPath);}
  }
  if(fs.existsSync(fixed.afterCrash)&&fs.readFileSync(fixed.afterCrash,"utf8").trim()===command){fs.unlinkSync(fixed.afterCrash);process.exit(87);}
};
const requestFile=argv.at(-1);
const request=requestFile&&fs.existsSync(requestFile)?JSON.parse(fs.readFileSync(requestFile,"utf8")):undefined;
if(argv[0]==="target"&&argv[3]===fixed.hangCommand&&fs.existsSync(fixed.hangFlag)) {
  fs.writeFileSync(fixed.childPid,String(process.pid));
  process.on("SIGTERM",()=>{});
  setInterval(()=>{},1000);
  await new Promise(()=>{});
}
if(argv[0]==="up") { crashWindow("up",argv.at(-1)); output(fixed.up); }
else if(argv[0]==="artifacts") { crashWindow("artifacts_export",argv.at(-1)); output(fixed.exportResult); }
else if(argv[0]==="down") { crashWindow("down",argv.at(-1)); output({version:"spawnfile.down-receipt.v1",deployment:"organization-unit",units_stopped:["organization-unit"],retained_volumes:[],errors:[]}); }
else if(argv[0]==="target") {
  const command=argv[3];
  const selected={fingerprint:"sha256:"+"1".repeat(32),handle:"opaque_"+"6".repeat(16)};
  if(command==="prepare_composed_run") {
    crashWindow(command,request.idempotency_key);
    const {receipt_digest:_,...template}=fixed.preparation;
    output(seal("spawnfile.composed-preparation.receipt.v1",{...template,request_digest:digest("spawnfile.composed-preparation.request.v1",request)}));
  } else if(command==="query_world_readiness") {
    output({readiness:fixed.readiness,readiness_digest:digest("spawnfile.target-world-readiness.document.v1",fixed.readiness),request_digest:digest("spawnfile.target-world-readiness.request.v1",request),run_id:request.run_id,version:"spawnfile.target-world-readiness-receipt.v1"});
  } else if(command==="attest_topology") {
    output(seal("spawnfile.target-topology-receipt.v1",{descriptor_digest:request.descriptor_digest,handoff_scope:"organization_to_private_service",organization:{data_network_attachment:"exact",egress_policy:"egress_only"},request_digest:digest("spawnfile.target-topology-attestation.request.v1",request),run_id:request.run_id,selected_target:selected,service_discovery:"dns_only",version:"spawnfile.target-topology-receipt.v1",world_network:"private_internal",world_service:{data_network_attachment:"exactly_one",egress_policy:"none",published_ports:"none"}}));
  } else if(command==="activate_topology") {
    crashWindow(command,digest("spawnfile.target-topology-attestation.request.v1",request));
    const topology=seal("spawnfile.target-topology-receipt.v1",{descriptor_digest:request.descriptor_digest,handoff_scope:"organization_to_private_service",organization:{data_network_attachment:"exact",egress_policy:"egress_only"},request_digest:digest("spawnfile.target-topology-attestation.request.v1",request),run_id:request.run_id,selected_target:selected,service_discovery:"dns_only",version:"spawnfile.target-topology-receipt.v1",world_network:"private_internal",world_service:{data_network_attachment:"exactly_one",egress_policy:"none",published_ports:"none"}});
    const marker={bundle_digest:"sha256:"+"f".repeat(64),run_id:request.run_id,state:"activated",topology_receipt_digest:topology.receipt_digest,topology_request_digest:topology.request_digest,version:"spawnfile.world-service-activation.v1"};
    output(seal("spawnfile.target-topology-activation-receipt.v1",{activation_digest:digest("spawnfile.world-service-activation.v1",marker),bundle_digest:marker.bundle_digest,run_id:request.run_id,state:"activated",topology_receipt_digest:topology.receipt_digest,topology_request_digest:topology.request_digest,version:"spawnfile.target-topology-activation-receipt.v1"}));
  } else if(command==="query_world_clock") {
    const invalid=fs.existsSync(fixed.invalidClock)?fs.readFileSync(fixed.invalidClock,"utf8").trim():"";
    const observedRun=invalid==="stale_run"?"run-stale-clock":request.run_id;
    const clock=invalid==="never_tick"?{completed_tick:0,next_tick:1,state:"running"}:{completed_tick:1,next_tick:2,state:"running"};
    const observation={action_count:0,clock,run_id:observedRun,version:request.expected.document_version,world_instance_id:request.expected.world_instance_id};
    output(seal("spawnfile.target-world-clock-receipt.v1",{action_count:0,activation_digest:invalid==="activation_mismatch"?"sha256:"+"9".repeat(64):request.activation_digest,activation_receipt_digest:request.activation_receipt_digest,clock:observation.clock,observation_digest:digest("spawnfile.target-world-clock.observation.v1",observation),request_digest:digest("spawnfile.target-world-clock.request.v1",request),run_id:observedRun,topology_receipt_digest:invalid==="topology_forgery"?"sha256:"+"8".repeat(64):request.topology_receipt_digest,topology_request_digest:request.topology_request_digest,version:"spawnfile.target-world-clock-receipt.v1",world_instance_id:request.expected.world_instance_id,world_service_handle:request.world_service_handle}));
  } else if(command==="snapshot_public_artifact") {
    const terminal={outcome_digest:"sha256:"+"0".repeat(64),reason:"completed",run_id:request.run_id,terminal_tick:4,version:"simfile.composed-world-terminal-signal.v1"};
    const bytes=Buffer.from(canonical(terminal));
    output({artifact_id:request.artifact.id,content_base64:bytes.toString("base64"),content_digest:"sha256:"+crypto.createHash("sha256").update(bytes).digest("hex"),media_type:"application/json",request_digest:digest("spawnfile.target-public-artifact-snapshot.request.v1",request),run_id:request.run_id,size_bytes:bytes.length,version:"spawnfile.target-public-artifact-snapshot.v1"});
  } else {
    const results={create_world_service:"opaque_"+"2".repeat(16),start_world_service:request.world_service_handle,attach_organization:"opaque_"+"4".repeat(16),stop_world_service:request.world_service_handle,export_evidence_volume:"opaque_"+"7".repeat(16),detach_organization:request.organization_attachment_handle,revoke_secret_bindings:request.secret_bindings_handle,cleanup_run:null};
    const operationHandles={create_world_service:"g",start_world_service:"h",attach_organization:"i",stop_world_service:"j",export_evidence_volume:"k",detach_organization:"l",revoke_secret_bindings:"m",cleanup_run:"n"};
    crashWindow(command,request.idempotency_key);
    const evidenceMode=fs.existsSync(fixed.invalidEvidence)?fs.readFileSync(fixed.invalidEvidence,"utf8").trim():"";
    const evidenceFiles=[{bytes:1,path:"actions/log.jsonl",sha256:"sha256:"+"a".repeat(64)},{bytes:2,path:"checkpoints/final.json",sha256:"sha256:"+"b".repeat(64)},{bytes:3,path:"projections/world.json",sha256:"sha256:"+"c".repeat(64)}];
    if(evidenceMode==="missing") evidenceFiles.shift();
    if(evidenceMode==="extra") evidenceFiles.push({bytes:1,path:"foreign/data",sha256:"sha256:"+"e".repeat(64)});
    const evidenceIndex=command==="export_evidence_volume"?{evidence_digest:"sha256:"+"d".repeat(64),export_handle:results[command],files:evidenceFiles,item_count:evidenceMode==="tamper"?99:evidenceFiles.length,labels:[],run_id:request.run_id,source:{evidence_volume_handle:evidenceMode==="source_mismatch"?"opaque_"+"9".repeat(16):request.evidence_volume_handle,state:"preserved"},state:"exported",version:"spawnfile.target-resource.export-index.v1"}:undefined;
    output(seal("spawnfile.target-resource.receipt.v1",{cleanup_state:command==="cleanup_run"?"removed":"not_requested",descriptor_digest:request.descriptor_digest,...(evidenceIndex?{evidence_index:evidenceIndex}:{}),export_state:command==="export_evidence_volume"?"exported":"not_requested",labels:[],operation:command,operation_handle:"opaque_"+operationHandles[command].repeat(16),request_digest:digest("spawnfile.target-resource.request.v1",request),result_handle:results[command],resulting_revision:request.expected_revision+1,run_id:request.run_id,selected_target:selected,version:"spawnfile.target-resource.receipt.v1"}));
  }
} else process.exitCode=2;
`;

test("built recover survives every public mutation window and executes its emitted command", async () => {
  await ensurePublicPackageBuild(path.resolve("."));
  const root = await mkdtemp(path.join(tmpdir(), "simfile-built-recover-"));
  try {
    const request = lifecycleRequest({ run_id: "run-built-recovery" });
    const harness = createComposedRunHarness(request);
    const journalPath = path.join(root, "journal.json");
    const fakeSpawnfile = path.join(root, "spawnfile.mjs");
    const logPath = path.join(root, "spawnfile.log");
    const producerLog = path.join(root, "producer.log");
    const hangFlag = path.join(root, "hang");
    const invalidClock = path.join(root, "invalid-clock");
    const invalidEvidence = path.join(root, "invalid-evidence");
    const childPid = path.join(root, "child.pid");
    const beforeCrash = path.join(root, "before-crash");
    const afterCrash = path.join(root, "after-crash");
    const effectState = path.join(root, "effects.json");
    const foreignJournal = path.join(root, "foreign-journal.json");
    const producer = path.join(root, "target-config-producer.mjs");
    const swapAfter = path.join(root, "swap-after");
    const requestDigest = digestComposedJson("simfile.composed-run-request.v1", request);
    const exportInvocation = `lci_${digestComposedJson(
      "simfile.composed-organization-export-operation.v1",
      { operation: "artifacts_export", request_digest: requestDigest },
    ).slice(7, 39)}`;
    const execution = {
      configuration: {
        organization_expectation: harness.configuration.organization_expectation,
        readiness_expectation: harness.configuration.readiness_expectation,
        terminal_tick: harness.configuration.terminal_tick,
        topology_expectation: {
          selected_target: harness.configuration.topology_expectation.selected_target,
        },
      },
      provider: {
        compiled_output_directory: path.join(root, "compiled"),
        evidence_destination_directory: path.join(root, "evidence"),
        evidence_mount_path: "/var/lib/simfile/evidence",
        lifecycle_invocations: {
          down: "lci_down_aaaaaaaaaaaa", export: exportInvocation,
          up: "lci_up_aaaaaaaaaaaaaa",
        },
        organization_handoff: {
          env_file: path.join(root, "runtime.env"),
          selected_target_receipt_file: path.join(root, "selected-target.json"),
          world_bindings_file: path.join(root, "world-bindings.json"),
        },
        organization_container_name: "organization-unit",
        organization_image_tag: "organization-unit:run-built-recovery",
        organization_path: path.join(root, "organization.yaml"),
        spawnfile_bin: fakeSpawnfile, spawnfile_cwd: root,
        target_config_producer: {
          args: [request.target.selector], command: producer,
          transport: "stdout_to_spawnfile_stdin",
        },
        terminal_artifact: {
          id: "terminal_receipt", max_bytes: 131_072,
          path: "/tmp/spawnfile-public/terminal.json",
        },
        world_readiness_port: 8080,
      },
      secret_bindings: [{ name: "provider_key", scope: "world", source_handle: "opaque_bbbbbbbbbbbbbbbb" }],
      version: "simfile.composed-execution.v1",
    } as const;
    await writeFile(producer, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(producerLog)}, process.argv[2] + "\\n");
process.stdout.write('{}');
`, { mode: 0o700 });
    await chmod(producer, 0o700);
    await writeFile(fakeSpawnfile, fixtureScript({
      afterCrash, beforeCrash, childPid, effectState, foreignJournal,
      invalidClock, invalidEvidence, swapAfter,
      exportResult: organizationExport(request.run_id), hangCommand: "snapshot_public_artifact",
      hangFlag, journalPath, logPath,
      preparation: lifecyclePreparation(request), readiness: lifecycleReadiness(request),
      up: lifecycleOrganizationUpReceipt(request.run_id, true),
    }), { mode: 0o600 });
    const initialJournal = createComposedPhaseJournal(
      request, "2026-08-07T00:00:00.000Z", execution,
    );
    const authorityDigest = initialJournal.authority_digest;
    await writeComposedPhaseJournal(journalPath, initialJournal);
    const failedRecovery = (): Promise<BuiltRecovery> => failedBuiltRecovery({ authorityDigest,
      cliPath: path.resolve("dist/cli/index.js"), cwd: path.resolve("."), journalPath,
      runId: request.run_id });
    const effectCount = (command: string): Promise<number> =>
      builtRecoveryEffectCount(effectState, command);
    const providerCommand = builtRecoveryProviderCommand;
    const rejectSwap = async (command: string, mode: "replace" | "symlink"): Promise<void> => {
      const owned = await readFile(journalPath);
      const foreignRequest = lifecycleRequest({ run_id: "run-foreign-journal" });
      await writeComposedPhaseJournal(foreignJournal, createForeignExecutionJournal(
        foreignRequest, "2026-08-07T00:00:00.000Z", execution,
      ));
      const foreignBytes = await readFile(foreignJournal, "utf8");
      const before = (await readFile(logPath, "utf8")).trim().split("\n").length;
      await writeFile(swapAfter, `${mode}:${command}\n`);
      await expectBuiltRecoveryAuthorityFailure({
        authorityDigest, cliPath: path.resolve("dist/cli/index.js"), cwd: path.resolve("."),
        journalPath, runId: request.run_id,
      });
      const calls = (await readFile(logPath, "utf8")).trim().split("\n")
        .slice(before).map((line) => JSON.parse(line) as string[]);
      const commands = calls.map(providerCommand);
      const attempted = commands.indexOf(command);
      assert.notEqual(attempted, -1, `${mode}:${command}`);
      assert.deepEqual(commands.slice(attempted), [command], `${mode}:${command}`);
      assert.equal(await readFile(journalPath, "utf8"), foreignBytes);
      await rm(journalPath, { force: true });
      await writeFile(journalPath, owned, { mode: 0o600 });
      await rm(foreignJournal, { force: true });
    };
    const failBefore = async (command: string): Promise<BuiltRecovery> => {
      await writeFile(beforeCrash, `${command}\n`);
      const receipt = await failedRecovery();
      assert.equal(receipt.status, "recovery_required");
      assert.equal(await effectCount(command), 0, command);
      return receipt;
    };
    const failAfter = async (command: string): Promise<BuiltRecovery> => {
      await writeFile(afterCrash, `${command}\n`);
      const receipt = await failedRecovery();
      assert.equal(receipt.status, "recovery_required");
      assert.equal(await effectCount(command), 1, command);
      return receipt;
    };
    const beforeTerminal = [
      "prepare_composed_run", "create_world_service", "start_world_service",
      "up", "attach_organization", "activate_topology",
    ] as const;
    await failBefore(beforeTerminal[0]);
    for (const [index, command] of beforeTerminal.entries()) {
      await failAfter(command);
      const next = beforeTerminal[index + 1];
      if (next !== undefined) await failBefore(next);
    }
    for (const invalid of [
      "never_tick", "stale_run", "topology_forgery", "activation_mismatch",
    ] as const) {
      await writeFile(invalidClock, `${invalid}\n`);
      const rejected = await failedRecovery();
      assert.equal(rejected.status, "recovery_required", invalid);
      const rejectedJournal = JSON.parse(await readFile(journalPath, "utf8")) as {
        current_phase: string; entries: Array<{ phase: string }>;
      };
      assert.equal(rejectedJournal.current_phase, "activated", invalid);
      assert.equal(rejectedJournal.entries.some(({ phase }) => phase === "tick_1"), false, invalid);
    }
    await rm(invalidClock);
    await writeFile(hangFlag, "hang\n");
    const child = spawn(process.execPath, [
      path.resolve("dist/cli/index.js"), "recover", "--journal", journalPath,
      "--run-id", request.run_id, "--authority-digest", authorityDigest,
    ], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "pipe"] });
    let interruptedStdout = "";
    let interruptedStderr = "";
    child.stdout.on("data", (chunk: Buffer) => { interruptedStdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { interruptedStderr += chunk.toString("utf8"); });
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (await readFile(childPid, "utf8").then(() => true).catch(() => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const providerPidText = await readFile(childPid, "utf8").catch(() => "");
    assert.notEqual(providerPidText, "", `hung provider was not reached\nstdout=${interruptedStdout}\nstderr=${interruptedStderr}`);
    const providerPid = Number(providerPidText);
    const interruptedAt = Date.now();
    child.kill("SIGTERM");
    const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const recovery = JSON.parse(interruptedStdout) as {
      recovery_command: string; signal: string; status: string;
    };
    assert.deepEqual(exited, { code: 143, signal: null }, interruptedStdout);
    assert.equal(interruptedStderr, "");
    assert.ok(Date.now() - interruptedAt < 5_000);
    assert.equal(recovery.status, "recovery_required");
    assert.equal(recovery.signal, "SIGTERM");
    assert.equal(recovery.recovery_command,
      composedRecoveryCommand(journalPath, request.run_id, authorityDigest));
    assert.throws(() => process.kill(providerPid, 0), /ESRCH/u);
    const interruptedCalls = await readFile(logPath, "utf8");
    assert.doesNotMatch(interruptedCalls, /export_evidence_volume|artifacts|cleanup_run/u);
    await rm(hangFlag);
    const afterTerminal = [
      "stop_world_service", "export_evidence_volume", "artifacts_export",
      "detach_organization", "down", "revoke_secret_bindings", "cleanup_run",
    ] as const;
    await failBefore(afterTerminal[0]);
    const crossRunRequest = lifecycleRequest({ run_id: "run-foreign-journal" });
    const modifiedDescriptor = lifecycleRequest({ descriptor_digest: `sha256:${"9".repeat(64)}` });
    await expectBuiltForeignJournalRejections({
      authorityDigest, cliPath: path.resolve("dist/cli/index.js"), cwd: path.resolve("."),
      foreignJournals: [
        createForeignExecutionJournal(crossRunRequest, "2026-08-07T00:00:00.000Z", execution),
        createForeignExecutionJournal(request, "2026-08-07T00:00:00.000Z", execution),
        createForeignExecutionJournal(modifiedDescriptor, "2026-08-07T00:00:00.000Z", execution),
      ],
      foreignPath: foreignJournal, journalPath, providerLogs: [logPath, producerLog],
      runId: request.run_id,
    });
    await rejectSwap(afterTerminal[0], "replace");
    let finalRecovery: BuiltRecovery | undefined = await failAfter(afterTerminal[0]);
    await failBefore(afterTerminal[1]);
    for (const invalid of ["missing", "extra", "tamper", "source_mismatch"] as const) {
      await writeFile(invalidEvidence, `${invalid}\n`);
      assert.equal((await failedRecovery()).status, "recovery_required", invalid);
      const rejected = JSON.parse(await readFile(journalPath, "utf8")) as {
        current_phase: string; entries: Array<{ phase: string }>;
      };
      assert.equal(rejected.current_phase, "world_paused", invalid);
      assert.equal(rejected.entries.some(({ phase }) => phase === "world_evidence_exported"), false);
    }
    await rm(invalidEvidence);
    for (const [index, command] of afterTerminal.slice(1).entries()) {
      await rejectSwap(command, index % 2 === 0 ? "symlink" : "replace");
      finalRecovery = await failAfter(command);
      const next = afterTerminal[index + 2];
      if (next !== undefined) await failBefore(next);
    }
    const commandBin = path.join(root, "bin");
    await mkdir(commandBin);
    const commandPath = path.join(commandBin, "simfile");
    await writeFile(commandPath, `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("dist/cli/index.js"))} "$@"
`, { mode: 0o700 });
    await chmod(commandPath, 0o700);
    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execute("/bin/sh", ["-c", finalRecovery!.recovery_command], {
        cwd: path.resolve("."), env: { ...process.env, PATH: `${commandBin}:${process.env.PATH ?? ""}` },
        timeout: 30_000,
      }));
    } catch (error) {
      const failed = error as Error & { stderr?: string; stdout?: string };
      const log = await readFile(logPath, "utf8").catch(() => "");
      throw new Error(`${failed.message}\nstdout=${failed.stdout ?? ""}\nstderr=${failed.stderr ?? ""}\nlog=${log}`);
    }
    assert.equal(stderr, "");
    const receipt = JSON.parse(stdout) as { status: string; run_id: string };
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.run_id, request.run_id);
    const stored = JSON.parse(await readFile(journalPath, "utf8")) as {
      current_phase: string; state: string;
    };
    assert.equal(stored.current_phase, "completed");
    assert.equal(stored.state, "complete");
    const calls = (await readFile(logPath, "utf8")).trim().split("\n").map(
      (line) => JSON.parse(line) as string[],
    );
    const targetCommands = calls.filter((call) => call[0] === "target").map((call) => call[3]);
    for (const command of beforeTerminal.filter((value) => value !== "up")) {
      assert.equal(targetCommands.filter((value) => value === command).length, 3, command);
    }
    for (const command of afterTerminal.filter((value) =>
      value !== "artifacts_export" && value !== "down")) {
      assert.ok(targetCommands.filter((value) => value === command).length >= 3, command);
    }
    assert.equal(targetCommands.filter((value) => value === "query_world_readiness").length, 1);
    assert.equal(targetCommands.filter((value) => value === "attest_topology").length, 1);
    assert.equal(targetCommands.filter((value) => value === "query_world_clock").length, 5);
    assert.equal(targetCommands.filter((value) => value === "snapshot_public_artifact").length, 2);
    assert.ok(calls.filter((call) => call[0] === "up").length >= 3);
    assert.ok(calls.filter((call) => call[0] === "artifacts").length >= 4);
    assert.ok(calls.filter((call) => call[0] === "down").length >= 3);
    assert.equal(calls.filter((call) => call[0] === "up")
      .every((call) => call.at(-1) === "lci_up_aaaaaaaaaaaaaa"), true);
    assert.equal(calls.filter((call) => call[0] === "artifacts")
      .every((call) => call.at(-1) === exportInvocation), true);
    assert.equal(calls.filter((call) => call[0] === "down")
      .every((call) => call.at(-1) === "lci_down_aaaaaaaaaaaa"), true);
    for (const command of [...beforeTerminal, ...afterTerminal]) {
      assert.equal(await effectCount(command), 1, command);
    }
    assert.deepEqual((await readFile(producerLog, "utf8")).trim().split("\n"),
      Array.from({ length: targetCommands.length }, () => request.target.selector));
    await expectBuiltRecoveryArgumentRejections({
      authorityDigest, cliPath: path.resolve("dist/cli/index.js"), cwd: path.resolve("."),
      journalPath, providerLogs: [logPath, producerLog], runId: request.run_id,
    });
    const callsBeforeRejections = calls.length;
    const rejectJournal = async (candidate: string): Promise<void> => {
      await assert.rejects(execute(process.execPath, [
        path.resolve("dist/cli/index.js"), "recover", "--journal", candidate,
        "--run-id", request.run_id, "--authority-digest", authorityDigest,
      ], { cwd: path.resolve("."), timeout: 5_000 }), (error: unknown) => {
        const failure = error as { code?: number; stdout?: string };
        return failure.code === 1 && failure.stdout === "";
      });
    };
    await rejectJournal(path.join(root, "missing.json"));
    const malformed = path.join(root, "malformed.json");
    await writeFile(malformed, "{\n");
    await rejectJournal(malformed);
    const secret = path.join(root, "secret.json");
    await writeFile(secret, '{"token":"token=must-not-load"}\n');
    await rejectJournal(secret);
    const crossed = path.join(root, "crossed.json");
    const crossRun = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    const crossExecution = crossRun.execution as {
      configuration: { readiness_expectation: { run_id: string } };
    };
    crossExecution.configuration.readiness_expectation.run_id = "run-foreign";
    const { journal_digest: _oldDigest, ...crossBody } = crossRun;
    crossRun.journal_digest = digestComposedJson("simfile.composed-phase-journal.v1", crossBody);
    await writeFile(crossed, `${JSON.stringify(crossRun)}\n`);
    await rejectJournal(crossed);
    assert.equal((await readFile(logPath, "utf8")).trim().split("\n").length,
      callsBeforeRejections);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
