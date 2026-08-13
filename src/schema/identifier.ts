import { z } from "zod";

export const simfileIdentifierPattern = "[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*";

export const simfileIdentifierSchema = z.string().regex(new RegExp(`^${simfileIdentifierPattern}$`), {
  message: "expected lowercase identifier with letters, numbers, dashes, or underscores"
});

export const isSimfileIdentifier = (value: unknown): value is string =>
  simfileIdentifierSchema.safeParse(value).success;

export const parseSimfileIdentifier = (value: unknown): string => {
  const result = simfileIdentifierSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(result.error.issues[0]?.message ?? "expected Simfile identifier");
  }
  return result.data;
};
