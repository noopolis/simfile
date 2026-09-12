import { writeFile } from "node:fs/promises";

import { matrix } from "../src/coverage/matrix.ts";
import { renderCoverageMarkdown } from "../src/coverage/render.ts";

const outputUrl = new URL("../docs/COVERAGE.md", import.meta.url);

await writeFile(outputUrl, renderCoverageMarkdown(matrix), "utf8");
