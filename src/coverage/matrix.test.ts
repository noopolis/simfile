import assert from "node:assert/strict";
import { readFile, readlink } from "node:fs/promises";
import { describe, it } from "node:test";

import { coveragePrimitives, matrix, systemViewTopLevelKeys } from "./matrix.js";
import { renderCoverageMarkdown } from "./render.js";

const allowedStatus = /^(?:implemented|deferred|planned:B[1-9][0-9]*)$/u;
const evidencePattern = /^(?:src|scripts)\/.+|^[A-Z][A-Z_]+\.md$/u;

const sourceFileNames = ["index.ts", "matrix.ts", "matrix.test.ts", "render.ts"];

const extractSystemViewTopLevelKeys = (systemsView: string): string[] => {
  const startMarker = "### Every Top-Level Key";
  const endMarker = "## 04 · The Full Schema";

  const startIndex = systemsView.indexOf(startMarker);
  const endIndex = systemsView.indexOf(endMarker, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, "docs/SYSTEMS_VIEW.md section markers were not found");

  const section = systemsView.slice(startIndex + startMarker.length, endIndex);
  const keys = new Set<string>();

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      continue;
    }

    const firstCell = trimmed.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/`([^`]+)`/gu)) {
      keys.add(match[1]);
    }
  }

  return [...keys];
};

describe("coverage matrix grammar", () => {
  it("uses only the closed status grammar and rejects unknown statuses", () => {
    for (const row of matrix) {
      assert.match(row.status, allowedStatus);
      assert.notEqual(row.status as string, "unknown");
    }
  });

  it("requires non-empty claim, specRef, and a concrete evidence path", () => {
    for (const row of matrix) {
      assert.notEqual(row.claim.trim(), "");
      assert.notEqual(row.specRef.trim(), "");
      assert.match(row.evidence, evidencePattern);
    }
  });
});

describe("coverage matrix parity with docs/SYSTEMS_VIEW.md", () => {
  it("covers every authored top-level key by exact set parity", async () => {
    const systemsView = await readFile(new URL("../../docs/SYSTEMS_VIEW.md", import.meta.url), "utf8");

    assert.deepEqual(
      [...new Set(
        matrix
          .filter((row) => row.subject.kind === "top-level")
          .map((row) => (row.subject as { kind: "top-level"; key: string }).key)
      )].sort(),
      extractSystemViewTopLevelKeys(systemsView).sort()
    );
  });

  it("keeps the checked-in top-level key constant from drifting off the document", async () => {
    const systemsView = await readFile(new URL("../../docs/SYSTEMS_VIEW.md", import.meta.url), "utf8");

    assert.deepEqual(
      [...systemViewTopLevelKeys].sort(),
      extractSystemViewTopLevelKeys(systemsView).sort()
    );
  });
});

describe("coverage matrix audit primitives", () => {
  it("covers all seven requested audit primitives by exact set parity", () => {
    assert.deepEqual(
      [...new Set(
        matrix
          .filter((row) => row.subject.kind === "primitive")
          .map((row) => (row.subject as { kind: "primitive"; primitive: string }).primitive)
      )].sort(),
      [...coveragePrimitives].sort()
    );

    assert.equal(coveragePrimitives.length, 7);
  });
});

describe("coverage matrix planned statuses", () => {
  it("rejects every planned:* row until a repo-local active Burnlist registry exists", () => {
    const plannedRows = matrix.filter((row) => row.status.startsWith("planned:"));

    assert.deepEqual(
      plannedRows,
      [],
      "planned statuses require an authoritative repo-local active Burnlist registry"
    );
  });
});

describe("generated docs/COVERAGE.md", () => {
  it("matches the manifest renderer byte-for-byte", async () => {
    const rendered = renderCoverageMarkdown(matrix);
    const checkedIn = await readFile(new URL("../../docs/COVERAGE.md", import.meta.url), "utf8");

    assert.equal(checkedIn, rendered);
  });
});

describe("coverage folder repository rules", () => {
  it("uses only named exports and stays under 400 lines per source file", async () => {
    for (const fileName of sourceFileNames) {
      const source = await readFile(new URL(`./${fileName}`, import.meta.url), "utf8");

      assert.doesNotMatch(source, /\bexport\s+default\b/u);
      assert.ok(
        source.split(/\r?\n/u).length < 400,
        `${fileName} must remain under 400 lines`
      );
    }
  });

  it("links CLAUDE.md to AGENTS.md for compatibility", async () => {
    assert.equal(
      await readlink(new URL("./CLAUDE.md", import.meta.url)),
      "AGENTS.md"
    );
  });
});
