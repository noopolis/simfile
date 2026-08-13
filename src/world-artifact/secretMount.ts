/** Simfile-owned, portable grammar for a scope/name secret mount. */
export const SIMFILE_SCOPED_SECRET_IDENTIFIER_GRAMMAR = "^[a-z][a-z0-9_-]{0,63}$" as const;
export const SIMFILE_SCOPED_SECRET_MOUNT_LAYOUT = "<scope>/<name>" as const;

const identifier = new RegExp(SIMFILE_SCOPED_SECRET_IDENTIFIER_GRAMMAR, "u");

export interface WorldSidecarBearerDeclaration {
  readonly scope: string;
  readonly name: string;
  readonly principal: string;
}

export const parseSimfileScopedSecretIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && identifier.test(value) ? value : undefined;

/** Returns the only relative path a mounted secret declaration may name. */
export const scopedSecretMountPath = (scope: unknown, name: unknown): string | undefined => {
  const parsedScope = parseSimfileScopedSecretIdentifier(scope);
  const parsedName = parseSimfileScopedSecretIdentifier(name);
  return parsedScope && parsedName ? `${parsedScope}/${parsedName}` : undefined;
};
