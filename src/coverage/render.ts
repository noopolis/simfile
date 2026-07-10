import type { CoverageRow, CoverageSubject } from "./matrix.js";

const GENERATED_HEADER = [
  "# Simfile Coverage",
  "",
  "> Generated from `src/coverage/matrix.ts`. Run `npm run coverage:render` after changing the manifest.",
  "",
  "This matrix uses the seven audit buckets requested by B40. In `DESIGN.md`, telemetry and markers are configuration, probes are a primitive, and entity lifecycle is the dormant seventh design primitive.",
  ""
].join("\n");

const TABLE_HEADER = ["| Subject | Claim | Spec | Status | Evidence |", "|---|---|---|---|---|"].join("\n");

const escapeCell = (value: string): string =>
  value.replace(/\r?\n/gu, " ").replace(/\|/gu, "\\|").trim();

const formatSubject = (subject: CoverageSubject): string =>
  subject.kind === "top-level" ? `top-level · \`${subject.key}\`` : `primitive · \`${subject.primitive}\``;

const formatRow = (row: CoverageRow): string => {
  const cells = [
    formatSubject(row.subject),
    escapeCell(row.claim),
    `\`${escapeCell(row.specRef)}\``,
    `\`${escapeCell(row.status)}\``,
    `\`${escapeCell(row.evidence)}\``
  ];

  return `| ${cells.join(" | ")} |`;
};

export const renderCoverageMarkdown = (rows: readonly CoverageRow[]): string => {
  const tableRows = rows.map(formatRow);
  const body = [GENERATED_HEADER, TABLE_HEADER, ...tableRows].join("\n");

  return `${body.replace(/\n+$/u, "")}\n`;
};
