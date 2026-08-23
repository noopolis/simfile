import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ComposedExecution } from "../compose/execution.js";
import { digestComposedJson } from "../compose/json.js";
import {
  lifecycleHandle,
  lifecyclePreparation,
  lifecycleRequest,
  preparedLifecycleJournal,
} from "../compose/lifecycle.test-helper.js";
import { SCRIPTED_NO_MODEL_AUTH_PROFILE } from "./organizationAuthentication.js";
import { createProductionOrganizationPorts } from "./productionOrganizationPorts.js";

const execution = (
  memberEngines: Readonly<Record<string, string>>,
): ComposedExecution => ({
  configuration: { organization_expectation: {
    deployment_name: "organization-unit",
    member_engines: memberEngines,
    selected_target_receipt_digest: `sha256:${"1".repeat(64)}`,
  } },
  provider: {
    compiled_output_directory: "/compiled",
    lifecycle_invocations: { up: "lci_startorganization000000000000" },
    organization_container_name: "organization-unit",
    organization_handoff: {
      env_file: "/private/runtime.env",
      selected_target_receipt_file: "/private/selected-target.json",
      world_bindings_file: "/private/world-bindings.json",
    },
    organization_image_tag: "organization-unit:run-one",
    organization_path: "/project/Spawnfile",
  },
} as ComposedExecution);

test("production organization up omits auth only for all-scripted members", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simfile-organization-auth-"));
  try {
    const capture = path.join(root, "argv.json");
    const fakeSpawnfile = path.join(root, "fake-spawnfile.mjs");
    const upReceipt = {
      deployment: { container_ids: ["organization-unit"], name: "organization-unit" },
      organization_handoff_handle: lifecycleHandle("5"),
      readiness: { moltnet_base_url: "http://127.0.0.1:1", state: "running" },
      run_id: "run-lifecycle",
      version: "spawnfile.up-receipt.v1",
    };
    await writeFile(fakeSpawnfile, `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args[0] === "lifecycle" && args[1] === "lookup") {
  process.stdout.write(JSON.stringify({ invocation_id: args[2], status: "not_applied", version: "spawnfile.lifecycle-lookup.v1" }));
} else {
  await writeFile(process.env.CAPTURE_FILE, JSON.stringify(args));
  process.stdout.write(${JSON.stringify(`${JSON.stringify(upReceipt)}\n`)});
}
`);

    const run = async (
      memberEngines: Readonly<Record<string, string>>,
      profile: string,
    ): Promise<string[]> => {
      const request = lifecycleRequest({ target: {
        auth_profile: profile,
        selector: "local-test-target",
      } });
      const preparation = lifecyclePreparation(request);
      const { version: _selectedVersion, ...selectedTarget } = preparation.selected_target;
      const journal = preparedLifecycleJournal(request);
      const driver = {
        cli: { env: { ...process.env, CAPTURE_FILE: capture }, spawnfileBin: fakeSpawnfile },
        guard: async () => undefined,
        load: async () => journal,
        mutation: (
          _journal: unknown,
          operation: string,
          idempotencyKey: string,
          expectedRevision: number,
          extra: Readonly<Record<string, unknown>>,
        ) => ({
          descriptor_digest: request.descriptor_digest,
          expected_revision: expectedRevision,
          idempotency_key: idempotencyKey,
          operation,
          run_id: request.run_id,
          selected_target: selectedTarget,
          version: "spawnfile.target-resource.request.v1",
          ...extra,
        }),
        runTarget: async (
          _operation: string,
          targetRequest: Readonly<Record<string, unknown>>,
        ) => {
          const body = {
            cleanup_state: "not_requested" as const,
            descriptor_digest: request.descriptor_digest,
            export_state: "not_requested" as const,
            labels: [],
            operation: "attach_organization" as const,
            operation_handle: lifecycleHandle("9"),
            request_digest: digestComposedJson(
              "spawnfile.target-resource.request.v1",
              targetRequest,
            ),
            result_handle: lifecycleHandle("6"),
            resulting_revision: 7,
            run_id: request.run_id,
            selected_target: selectedTarget,
            version: "spawnfile.target-resource.receipt.v1" as const,
          };
          return { ...body, receipt_digest: digestComposedJson(
            "spawnfile.target-resource.receipt.v1", body,
          ) };
        },
      };
      await createProductionOrganizationPorts(execution(memberEngines), driver as never)
        .startOrganization({
          idempotency_key: `idem_${"a".repeat(16)}`,
          run_id: request.run_id,
          signal: new AbortController().signal,
          world_readiness_digest: `sha256:${"2".repeat(64)}`,
        });
      return JSON.parse(await readFile(capture, "utf8")) as string[];
    };

    const scriptedArgv = await run({
      "agent:one": "scripted",
      "agent:two": "scripted",
    }, SCRIPTED_NO_MODEL_AUTH_PROFILE);
    assert.equal(scriptedArgv.includes("--auth-profile"), false);

    for (const memberEngines of [
      { "agent:one": "pi" },
      { "agent:one": "scripted", "agent:two": "pi" },
    ] as readonly Readonly<Record<string, string>>[]) {
      const authenticatedArgv = await run(memberEngines, "developer-profile");
      const authFlag = authenticatedArgv.indexOf("--auth-profile");
      assert.notEqual(authFlag, -1);
      assert.equal(authenticatedArgv[authFlag + 1], "developer-profile");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
