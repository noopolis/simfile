import type { Simfile } from "./model.js";

const duplicateIds = (values: readonly string[]): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }

  return [...duplicates].sort();
};

const assertUnique = (label: string, values: readonly string[]): void => {
  const duplicates = duplicateIds(values);
  if (duplicates.length > 0) {
    throw new Error(`${label} contains duplicate ids: ${duplicates.join(", ")}`);
  }
};

export const validateSimfileSemantics = (simfile: Simfile): string[] => {
  assertUnique("clock.phases", simfile.clock.phases.map((phase) => phase.id));
  assertUnique("actors", simfile.actors.map((actor) => actor.id));
  assertUnique("locations", simfile.locations.map((location) => location.id));
  assertUnique("actions", simfile.actions.map((action) => action.id));
  assertUnique("ledger.events", simfile.ledger?.events ?? []);

  const warnings: string[] = [];
  if (simfile.actors.length === 0) {
    warnings.push("simulation has no actors");
  }
  if (simfile.locations.length === 0) {
    warnings.push("simulation has no locations");
  }
  return warnings;
};
