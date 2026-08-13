const RESOURCE_KINDS = ["entity", "sense", "affordance", "effect"] as const;
const PORTABLE_SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

declare const localReferenceBrand: unique symbol;
declare const worldIdBrand: unique symbol;
declare const worldPathBrand: unique symbol;
declare const canonicalAddressBrand: unique symbol;

export type WorldResourceKind = (typeof RESOURCE_KINDS)[number];

export type LocalResourceReference = string & {
  readonly [localReferenceBrand]: "LocalResourceReference";
};

export type WorldId = string & {
  readonly [worldIdBrand]: "WorldId";
};

export type WorldPath = readonly WorldId[] & {
  readonly [worldPathBrand]: "WorldPath";
};

export type CanonicalWorldAddress = string & {
  readonly [canonicalAddressBrand]: "CanonicalWorldAddress";
};

export interface WorldAddressScope {
  readonly id: WorldId;
  readonly ancestors?: WorldPath;
}

export interface ResolvedWorldResourceEntry {
  readonly address: CanonicalWorldAddress;
  readonly reference: LocalResourceReference;
}

export interface ResolvedWorldResourceRegistry {
  readonly world: WorldPath;
  readonly entries: readonly ResolvedWorldResourceEntry[];
}

export const parseLocalResourceReference = (input: unknown): LocalResourceReference => {
  if (typeof input !== "string") {
    throw new TypeError("A local resource reference must be a string.");
  }

  const separator = input.indexOf(":");
  if (separator <= 0 || separator !== input.lastIndexOf(":")) {
    throw new TypeError(`Invalid local resource reference: ${JSON.stringify(input)}.`);
  }

  const kind = input.slice(0, separator);
  const localId = input.slice(separator + 1);
  if (!isWorldResourceKind(kind) || !isPortableSegment(localId)) {
    throw new TypeError(`Invalid local resource reference: ${JSON.stringify(input)}.`);
  }

  return input as LocalResourceReference;
};

export const parseWorldId = (input: unknown): WorldId => {
  if (!isPortableSegment(input)) {
    throw new TypeError("A world id must be one portable lowercase kebab-case segment.");
  }

  return input as WorldId;
};

export const createWorldPath = (...segments: readonly unknown[]): WorldPath => {
  if (segments.length === 0) {
    throw new TypeError("A world path must contain nonempty portable lowercase kebab-case segments.");
  }

  return Object.freeze(segments.map(parseWorldId)) as unknown as WorldPath;
};

export const resolveWorldAddress = (
  world: WorldAddressScope,
  reference: LocalResourceReference,
): CanonicalWorldAddress => {
  const path = resolvedWorldPath(world);
  const localReference = parseLocalResourceReference(reference);
  const [kind, localId] = localReference.split(":") as [WorldResourceKind, string];
  return `world://${path.join("/")}/${kind}/${localId}` as CanonicalWorldAddress;
};

export const resolveWorldResourceRegistry = (
  world: WorldAddressScope,
  references: readonly LocalResourceReference[],
): ResolvedWorldResourceRegistry => {
  const path = resolvedWorldPath(world);
  const entries: ResolvedWorldResourceEntry[] = [];
  const seen = new Set<CanonicalWorldAddress>();

  for (const reference of references) {
    const canonicalAddress = resolveWorldAddress(world, reference);
    if (seen.has(canonicalAddress)) {
      throw new TypeError(`Canonical world address collision: ${canonicalAddress}.`);
    }
    seen.add(canonicalAddress);
    entries.push(Object.freeze({ address: canonicalAddress, reference: parseLocalResourceReference(reference) }));
  }

  return Object.freeze({ world: path, entries: Object.freeze(entries) });
};

export const isWorldResourceKind = (input: unknown): input is WorldResourceKind =>
  typeof input === "string" && (RESOURCE_KINDS as readonly string[]).includes(input);

const isPortableSegment = (input: unknown): input is string =>
  typeof input === "string" && PORTABLE_SEGMENT.test(input);

const resolvedWorldPath = (world: WorldAddressScope): WorldPath => {
  if (!world || typeof world !== "object") {
    throw new TypeError("Resolution requires a world scope.");
  }

  const { id, ancestors } = world;
  const worldId = parseWorldId(id);
  if (ancestors === undefined) {
    return createWorldPath(worldId);
  }
  if (!Array.isArray(ancestors)) {
    throw new TypeError("A world ancestor path must be an ordered array of portable segments.");
  }

  return createWorldPath(...ancestors, worldId);
};
