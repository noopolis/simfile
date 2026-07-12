import { writeFile } from "node:fs/promises";

import { matrix } from "../src/coverage/matrix.js";
import { renderCoverageMarkdown } from "../src/coverage/render.js";

const outputUrl = new URL("../docs/COVERAGE.md", import.meta.url);

await writeFile(outputUrl, renderCoverageMarkdown(matrix), "utf8");
