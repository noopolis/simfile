import YAML from "yaml";

import { simfileSchema, type Simfile } from "./model.js";
import { validateSimfileSemantics } from "./semantic.js";

export interface ParseSimfileOptions {
  path?: string;
}

export interface ParseSimfileResult {
  simfile: Simfile;
  warnings: string[];
}

const parseRawDocument = (source: string, path?: string): unknown => {
  if (path?.endsWith(".json")) {
    return JSON.parse(source);
  }

  return YAML.parse(source);
};

export const parseSimfileSource = (
  source: string,
  options: ParseSimfileOptions = {}
): ParseSimfileResult => {
  const raw = parseRawDocument(source, options.path);
  const simfile = simfileSchema.parse(raw);
  const warnings = validateSimfileSemantics(simfile);
  return { simfile, warnings };
};
