import type {
  DynamicsJsonObject,
  DynamicsProvider,
  DynamicsProviderObservation,
  ReadonlyDynamicsJsonObject,
  ReadonlyDynamicsJsonValue
} from "../dynamics/types.js";
import type { LocalResourceReference } from "../world/addresses.js";

export const WORLD_SURFACE_API_VERSION = "simfile.world-surface.v1" as const;
export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema" as const;

interface BoundedSchemaAnnotations {
  readonly description?: string;
  readonly title?: string;
}

interface BoundedSchemaValueConstraints {
  readonly const?: ReadonlyDynamicsJsonValue;
  readonly enum?: readonly ReadonlyDynamicsJsonValue[];
}

export interface BoundedNullSchema
  extends BoundedSchemaAnnotations, BoundedSchemaValueConstraints {
  readonly type: "null";
}

export interface BoundedBooleanSchema
  extends BoundedSchemaAnnotations, BoundedSchemaValueConstraints {
  readonly type: "boolean";
}

export interface BoundedNumberSchema
  extends BoundedSchemaAnnotations, BoundedSchemaValueConstraints {
  readonly maximum: number;
  readonly minimum: number;
  readonly type: "number" | "integer";
}

export interface BoundedStringSchema
  extends BoundedSchemaAnnotations, BoundedSchemaValueConstraints {
  readonly maxLength: number;
  readonly minLength?: number;
  readonly type: "string";
}

export interface BoundedArraySchema
  extends BoundedSchemaAnnotations, BoundedSchemaValueConstraints {
  readonly items: BoundedJsonSchemaNode;
  readonly maxItems: number;
  readonly minItems?: number;
  readonly type: "array";
}

export interface BoundedObjectSchema
  extends BoundedSchemaAnnotations, BoundedSchemaValueConstraints {
  readonly additionalProperties: false;
  readonly maxProperties?: number;
  readonly minProperties?: number;
  readonly properties: Readonly<Record<string, BoundedJsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly type: "object";
}

export type BoundedJsonSchemaNode =
  | BoundedNullSchema
  | BoundedBooleanSchema
  | BoundedNumberSchema
  | BoundedStringSchema
  | BoundedArraySchema
  | BoundedObjectSchema;

export type BoundedJsonSchema = BoundedJsonSchemaNode & {
  readonly $schema?: typeof JSON_SCHEMA_2020_12;
};

export type BoundedObjectJsonSchema = BoundedObjectSchema & {
  readonly $schema?: typeof JSON_SCHEMA_2020_12;
};

export type WorldEntityReference = `entity:${string}`;
export type WorldSenseReference = `sense:${string}`;
export type WorldAffordanceReference = `affordance:${string}`;
export type WorldEffectReference = `effect:${string}`;

export interface WorldEntityDefinition {
  readonly address: WorldEntityReference;
  readonly dynamics_address: string;
}

export interface ReadonlyWorldSurfaceObservationChannel {
  readonly components: Readonly<Record<string, number>>;
  readonly frame?: string;
  readonly sense_address: string;
  readonly subject_address: string;
  readonly unit?: string;
}

export interface ReadonlyWorldSurfaceObservation {
  readonly channels: readonly ReadonlyWorldSurfaceObservationChannel[];
}

export interface WorldSenseProjectionInput {
  readonly holder: LocalResourceReference;
  readonly observation: ReadonlyWorldSurfaceObservation;
}

export interface WorldSenseDefinition {
  readonly dynamics_senses: readonly string[];
  readonly output: "simfile.numeric-observation.v1";
  project(input: WorldSenseProjectionInput): DynamicsProviderObservation;
}

export type WorldAffordanceTargetSelector =
  | { readonly kind: "holder" }
  | {
    readonly kind: "fixed";
    readonly targets: readonly WorldEntityReference[];
  };

export interface WorldAffordanceContext {
  readonly holder: LocalResourceReference;
  readonly observation: ReadonlyWorldSurfaceObservation;
  readonly target: LocalResourceReference;
}

export interface WorldAffordanceLoweringInput extends WorldAffordanceContext {
  readonly input: ReadonlyDynamicsJsonObject;
}

export interface WorldMechanicsResult {
  readonly accepted: boolean;
  readonly code?: string;
  readonly message?: string;
}

export interface WorldAffordanceDefinition {
  readonly dynamics_action: string;
  readonly input_schema: BoundedObjectJsonSchema;
  readonly rejection_codes: readonly string[];
  readonly target_selector: WorldAffordanceTargetSelector;
  available(input: WorldAffordanceContext): boolean;
  lower(input: WorldAffordanceLoweringInput): DynamicsJsonObject;
  project_result?(result: WorldMechanicsResult): DynamicsJsonObject;
}

export interface WorldEffectDefinition {
  readonly dynamics_event: string;
  readonly payload_schema: BoundedObjectJsonSchema;
}

export interface WorldSurfaceDefinition {
  readonly api_version: typeof WORLD_SURFACE_API_VERSION;
  readonly affordances: Readonly<
    Record<WorldAffordanceReference, WorldAffordanceDefinition>
  >;
  readonly effects: Readonly<Record<WorldEffectReference, WorldEffectDefinition>>;
  readonly entities: Readonly<Record<string, WorldEntityDefinition>>;
  readonly senses: Readonly<Record<WorldSenseReference, WorldSenseDefinition>>;
}

export interface CheckedWorldEntityDefinition {
  readonly address: LocalResourceReference;
  readonly alias: string;
  readonly dynamics_address: string;
}

export interface CheckedWorldSenseDefinition {
  readonly address: LocalResourceReference;
  readonly dynamics_senses: readonly string[];
  readonly output: "simfile.numeric-observation.v1";
}

export type CheckedWorldAffordanceTargetSelector =
  | { readonly kind: "holder" }
  | {
    readonly kind: "fixed";
    readonly targets: readonly LocalResourceReference[];
  };

export interface CheckedWorldAffordanceDefinition {
  readonly address: LocalResourceReference;
  readonly dynamics_action: string;
  readonly input_schema: BoundedObjectJsonSchema;
  readonly rejection_codes: readonly string[];
  readonly target_selector: CheckedWorldAffordanceTargetSelector;
}

export interface CheckedWorldEffectDefinition {
  readonly address: LocalResourceReference;
  readonly dynamics_event: string;
  readonly payload_schema: BoundedObjectJsonSchema;
}

export interface WorldProjectedEffect {
  readonly effect: LocalResourceReference;
  readonly payload: ReadonlyDynamicsJsonObject;
}

export interface WorldSurfaceRegistry {
  readonly affordances: readonly CheckedWorldAffordanceDefinition[];
  readonly api_version: typeof WORLD_SURFACE_API_VERSION;
  readonly effects: readonly CheckedWorldEffectDefinition[];
  readonly entities: readonly CheckedWorldEntityDefinition[];
  readonly senses: readonly CheckedWorldSenseDefinition[];
  isAffordanceAvailable(
    affordance: LocalResourceReference,
    input: WorldAffordanceContext
  ): boolean;
  lowerAffordance(
    affordance: LocalResourceReference,
    input: WorldAffordanceLoweringInput
  ): ReadonlyDynamicsJsonObject;
  projectAffordanceResult(
    affordance: LocalResourceReference,
    result: WorldMechanicsResult
  ): ReadonlyDynamicsJsonObject | undefined;
  projectEffect(dynamicsEvent: string, payload: unknown): WorldProjectedEffect;
  projectSense(
    sense: LocalResourceReference,
    input: WorldSenseProjectionInput
  ): ReadonlyWorldSurfaceObservation;
}

export interface DynamicsWorldModule {
  createDynamicsProvider(): DynamicsProvider;
  createWorldSurfaceDefinition(): WorldSurfaceDefinition;
}
