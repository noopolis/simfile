import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Writable } from "node:stream";

import { streamViewerExtensionFile } from "./viewerAssets.js";

class ResponseSink extends Writable {
  readonly chunks: Buffer[] = [];
  status = 0;

  writeHead(status: number): ServerResponse {
    this.status = status;
    return this as unknown as ServerResponse;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

const finished = async (response: ResponseSink): Promise<void> => {
  if (!response.writableFinished) await once(response, "finish");
};

describe("viewer asset streaming", () => {
  it("serves only the startup bytes and rejects a symlink escape", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simfile-viewer-assets-"));
    const outside = await mkdtemp(path.join(tmpdir(), "simfile-viewer-outside-"));
    try {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "nested", "module.js"), "export {};");
      await writeFile(path.join(outside, "secret.js"), "secret");
      const canonicalRoot = await realpath(root);
      const expected = createHash("sha256").update("export {};").digest("hex");

      const served = new ResponseSink();
      await streamViewerExtensionFile(
        served as unknown as ServerResponse,
        canonicalRoot,
        "nested/module.js",
        expected,
      );
      await finished(served);
      assert.equal(served.status, 200);
      assert.equal(Buffer.concat(served.chunks).toString(), "export {};");

      await symlink(path.join(outside, "secret.js"), path.join(root, "escape.js"));
      const escaped = new ResponseSink();
      await streamViewerExtensionFile(
        escaped as unknown as ServerResponse,
        canonicalRoot,
        "escape.js",
        expected,
      );
      await finished(escaped);
      assert.equal(escaped.status, 404);

      await writeFile(path.join(root, "nested", "module.js"), "changed");
      const changed = new ResponseSink();
      await streamViewerExtensionFile(
        changed as unknown as ServerResponse,
        canonicalRoot,
        "nested/module.js",
        expected,
      );
      await finished(changed);
      assert.equal(changed.status, 409);
    } finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(outside, { force: true, recursive: true }),
      ]);
    }
  });
});
