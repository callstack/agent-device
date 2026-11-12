import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
  InteractionTarget,
} from '@agent-device/contracts/client';
import {
  readOptionalInteger as optionalInteger,
  readOptionalNumber as optionalNumberValue,
  type CliFlags,
} from '@agent-device/contracts/command';
import { getFlagDefinitionsForKey } from '@agent-device/command-registry/flag-registry';
import type { FlagDefinition, FlagKey } from '@agent-device/command-registry/flag-types';
import { AppError } from '@agent-device/kernel/errors';
import {
  type LEASE_DEVICE_SPEC_KEYS,
  requireLeaseDeviceSpec,
} from '@agent-device/contracts/lease-scope';
import type { RepeatedInput } from '@agent-device/contracts/interaction';
import type { JsonSchema } from './command-contract.ts';
import {
  commonProperties,
  commonToClientOptions,
  readCommonInput,
  type CommonCommandInput,
} from './common-input-fields.ts';
import {
  refuseRetiredInput,
  type InputAudience,
  type InputAudienceMap,
  type OperatorInputSource,
} from './input-audience.ts';
import {
  compactRecord,
  optionalAnyString,
  optionalBoolean,
  optionalEnum,
  optionalRecord,
  optionalString,
  optionalStringArray,
  readInputRecord,
  readRecordField,
  requiredNumber,
} from './input-readers.ts';

export type SelectorSnapshotInput = {
  depth?: number;
  scope?: string;
  raw?: boolean;
};

export type PointInput = { x: number; y: number };

function commandInputSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  retiredKeys: ReadonlySet<string> = new Set(),
): JsonSchema {
  const common = Object.entries(commonProperties()).filter(([key]) => !retiredKeys.has(key));
  return {
    type: 'object',
    properties: {
      ...Object.fromEntries(common),
      ...properties,
    },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * A non-strict object shape, for what a command RETURNS. It deliberately omits
 * `additionalProperties: false` and never injects the common device-selection fields, so
 * additive response fields such as `cost` keep validating. An advertised INPUT object is
 * built by `commandInputSchema` instead, which is strict and carries those fields.
 */
export function objectSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
  description?: string,
): JsonSchema {
  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function pointSchema(description: string): JsonSchema {
  return {
    type: 'object',
    description,
    properties: {
      x: { type: 'number' },
      y: { type: 'number' },
    },
    required: ['x', 'y'],
    additionalProperties: false,
  };
}

export function enumSchema(values: readonly string[], description?: string): JsonSchema {
  return { type: 'string', enum: values, ...(description ? { description } : {}) };
}

/** A single-valued string schema, for a discriminant field an output shape always fixes. */
export function constSchema(value: string): JsonSchema {
  return { type: 'string', const: value };
}

export function stringSchema(description?: string): JsonSchema {
  return { type: 'string', ...(description ? { description } : {}) };
}

export function nullableStringSchema(description?: string): JsonSchema {
  return { type: ['string', 'null'], ...(description ? { description } : {}) };
}

export function numberSchema(
  description?: string,
  options: { min?: number; max?: number } = {},
): JsonSchema {
  return {
    type: 'number',
    ...(description ? { description } : {}),
    ...(options.min === undefined ? {} : { minimum: options.min }),
    ...(options.max === undefined ? {} : { maximum: options.max }),
  };
}

function integerSchema(description?: string): JsonSchema {
  return { type: 'integer', ...(description ? { description } : {}) };
}

export function booleanSchema(description?: string): JsonSchema {
  return { type: 'boolean', ...(description ? { description } : {}) };
}

export function stringArraySchema(description?: string): JsonSchema {
  return {
    type: 'array',
    items: { type: 'string' },
    ...(description ? { description } : {}),
  };
}

export function looseObjectSchema(description?: string): JsonSchema {
  return {
    type: 'object',
    additionalProperties: true,
    ...(description ? { description } : {}),
  };
}

type FieldReader<T> = (record: Record<string, unknown>, key: string) => T | undefined;

export type CommandField<T> = {
  schema: JsonSchema;
  required: boolean;
  read: FieldReader<T>;
  /** Who may write the key. Absent means the model — see `input-audience.ts`. */
  audience?: InputAudience;
};

export type CommandFieldMap = Record<string, CommandField<unknown>>;

export type InferCommandFields<TFields extends CommandFieldMap> = {
  [
    TKey in keyof TFields as TFields[TKey]['required'] extends true ? TKey : never
  ]: TFields[TKey] extends CommandField<infer TValue> ? TValue : never;
} & {
  [
    TKey in keyof TFields as TFields[TKey]['required'] extends true ? never : TKey
  ]?: TFields[TKey] extends CommandField<infer TValue> ? TValue : never;
};

export type InferCommandInput<TFields extends CommandFieldMap> = InferCommandFields<TFields> &
  CommonCommandInput &
  AgentDeviceRequestOverrides &
  AgentDeviceSelectionOptions;

export function requiredField<T>(
  field: CommandField<T>,
): CommandField<Exclude<T, undefined>> & { required: true } {
  return { ...field, required: true } as CommandField<Exclude<T, undefined>> & {
    required: true;
  };
}

export function stringField(
  description?: string,
  options: { allowEmpty?: boolean } = {},
): CommandField<string> {
  return optionalField(
    stringSchema(description),
    options.allowEmpty === true ? optionalAnyString : optionalString,
  );
}

/**
 * A released input key that was removed. Declared in the field map so the
 * projection seam (`readFieldInput`) refuses it with migration guidance
 * instead of silently dropping it; excluded from the JSON schema so tools no
 * longer advertise it.
 */
export function retiredField(message: string): CommandField<never> {
  return {
    schema: { type: 'null' },
    required: false,
    audience: { kind: 'retired', message },
    read: (record, key) => refuseRetiredInput(record, key, message),
  };
}

/**
 * A key the CLI and the Node client accept but no model-facing tool schema may
 * advertise or admit — a credential, an endpoint a credential is sent to, or an
 * operator infrastructure path. `source` names how the operator supplies it, and
 * the refusal is rendered from that.
 */
export function operatorField<T>(
  field: CommandField<T>,
  source: OperatorInputSource,
): CommandField<T> {
  return { ...field, audience: { kind: 'operator', source } };
}

export function numberField(
  description?: string,
  options: { min?: number; max?: number } = {},
): CommandField<number> {
  return optionalField(numberSchema(description, options), (record, key) =>
    optionalNumberValue(record, key, options),
  );
}

export function integerField(
  description?: string,
  options: { min?: number; max?: number } = {},
): CommandField<number> {
  return optionalField(integerSchemaWithBounds(description, options), (record, key) =>
    optionalInteger(record, key, options),
  );
}

export function booleanField(description?: string): CommandField<boolean> {
  return optionalField(booleanSchema(description), optionalBoolean);
}

/**
 * Builds a command's input field from the option's ONE declaration.
 *
 * A hand-written field — `booleanField('Include an initial interactive
 * snapshot…')` — restates two facts the option already declared: its value type
 * (`type: 'boolean'` on the `FlagDefinition`) and its description, as a second,
 * differently-worded copy of the same sentence. Neither copy decides anything
 * and both drift: `open --foreground` had one description rewritten across four
 * files at once because no file owned it.
 *
 * Derived here instead:
 *  - the JSON schema shape and its bounds come from the declaration's `type`,
 *    `enumValues`, `min` and `max`;
 *  - the description comes from the declaration's `inputDescription`;
 *  - the TypeScript value type comes from `CliFlags[key]`, which is already
 *    where that flag's type is declared.
 *
 * So an option's description is one edit, and a command cannot advertise an
 * input its own CLI flag does not parse.
 */
export function optionField<TKey extends FlagKey>(
  key: TKey,
): CommandField<NonNullable<CliFlags[TKey]>> {
  return buildOptionField(optionDeclaration(key)) as CommandField<NonNullable<CliFlags[TKey]>>;
}

/**
 * Fails closed: a command may derive a field only from an option that actually
 * declares a tool/SDK audience, rather than publishing an undescribed input.
 */
function optionDeclaration(key: FlagKey): FlagDefinition {
  const declared = getFlagDefinitionsForKey(key).filter(
    (definition) => definition.inputDescription !== undefined,
  );
  const [definition, ...extra] = declared;
  if (!definition) {
    throw new Error(`Flag ${key} declares no inputDescription; optionField cannot derive a field`);
  }
  if (extra.length > 0) {
    throw new Error(`Flag ${key} declares inputDescription more than once`);
  }
  return definition;
}

function buildOptionField(definition: FlagDefinition): CommandField<unknown> {
  const description = definition.inputDescription;
  const bounds = { min: definition.min, max: definition.max };
  switch (definition.type) {
    case 'boolean':
      return booleanField(description) as CommandField<unknown>;
    case 'int':
      return integerField(description, bounds) as CommandField<unknown>;
    case 'number':
      return numberField(description, bounds) as CommandField<unknown>;
    case 'string':
      return stringField(description) as CommandField<unknown>;
    case 'enum':
      return enumField(optionEnumValues(definition), description) as CommandField<unknown>;
    case 'booleanOrString':
      throw new Error(
        `Flag ${definition.key} is booleanOrString; declare its field shape explicitly with jsonSchemaField`,
      );
  }
}

function optionEnumValues(definition: FlagDefinition): readonly string[] {
  const values = definition.enumValues;
  if (!values) {
    throw new Error(`Flag ${definition.key} is an enum with no enumValues`);
  }
  return values;
}

export function enumField<const TValues extends readonly string[]>(
  values: TValues,
  description?: string,
): CommandField<TValues[number]> {
  return optionalField(enumSchema(values, description), (record, key) =>
    optionalEnum(record, key, values),
  );
}

export function looseObjectField(description?: string): CommandField<Record<string, unknown>> {
  return optionalField(looseObjectSchema(description), optionalRecord);
}

export function stringArrayField(description?: string): CommandField<string[]> {
  return optionalField(stringArraySchema(description), optionalStringArray);
}

export function jsonSchemaField<T>(schema: JsonSchema): CommandField<T> {
  return optionalField(schema, (record, key) => record[key] as T | undefined);
}

export function customField<T>(
  schema: JsonSchema,
  read: (record: Record<string, unknown>, key: string) => T | undefined,
): CommandField<T> {
  return optionalField(schema, read);
}

export function pointField(description: string): CommandField<PointInput> {
  return optionalField(pointSchema(description), (record, key) =>
    record[key] === undefined ? undefined : readPoint(record, key),
  );
}

export function pointArrayField(
  description: string,
  options: { min: number; max: number },
): CommandField<PointInput[]> {
  return optionalField(
    {
      type: 'array',
      description,
      items: pointSchema('One contact point.'),
      minItems: options.min,
      maxItems: options.max,
    },
    (record, key) => (record[key] === undefined ? undefined : readPointArray(record, key)),
  );
}

function readPointArray(record: Record<string, unknown>, key: string): PointInput[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be an array of points.`);
  }
  return value.map((item: unknown, index) => {
    const itemKey = `${key}[${index}]`;
    return readPoint({ [itemKey]: item }, itemKey);
  });
}

export function selectorSnapshotFields() {
  return {
    depth: integerField('Snapshot traversal depth.', { min: 0 }),
    scope: stringField('Snapshot scope selector used before resolution.'),
    raw: booleanField('Use raw snapshot data during selector resolution.'),
  };
}

export function repeatedFields() {
  return {
    count: integerField('Number of press/click repetitions.', { min: 1 }),
    intervalMs: integerField('Delay between repeated press/click actions.', { min: 0 }),
    holdMs: integerField('Hold duration for each action.', { min: 0 }),
    jitterPx: integerField(
      'Deterministic per-axis coordinate jitter in pixels (each press offsets x and y by up to this amount).',
      { min: 0 },
    ),
    doubleTap: booleanField('Request a double-tap action.'),
  };
}

/**
 * The opt-out of the checks that follow a scroll or swipe. It is the caller's policy for how it
 * verifies the screen, so no model-facing tool schema advertises or admits it; an operator sets it
 * through the environment or the user config, which the tool route merges outside the model.
 */
export function postGestureStabilizationFields() {
  return {
    postGestureStabilization: operatorField(optionField('postGestureStabilization'), {
      operatorConfig: true,
    }),
  };
}

/**
 * The device spec a proxy lease is allocated by, on the commands that allocate one. The fields
 * reach the daemon request; a daemon refuses them, and the CLI drops them once a proxy backend has
 * leased a device by them.
 */
export function leaseDeviceSpecFields() {
  return {
    osVersion: leaseDeviceSpecField('osVersion'),
    imageTag: leaseDeviceSpecField('imageTag'),
    deviceMode: leaseDeviceSpecField('deviceMode'),
    deviceBaseline: leaseDeviceSpecField('deviceBaseline'),
    physical: leaseDeviceSpecField('physical'),
  };
}

function leaseDeviceSpecField<TKey extends (typeof LEASE_DEVICE_SPEC_KEYS)[number]>(key: TKey) {
  return customField(
    optionField(key).schema,
    (record) => requireLeaseDeviceSpec({ [key]: record[key] }).spec[key],
  );
}

export function fieldsInputSchema(fields: CommandFieldMap): JsonSchema {
  return commandInputSchema(
    fieldProperties(fields),
    requiredFieldNames(fields),
    retiredFieldNames(fields),
  );
}

export function readFieldInput<TFields extends CommandFieldMap>(
  input: unknown,
  fields: TFields,
): InferCommandInput<TFields> {
  const record = readInputRecord(input);
  const commandOptions = Object.fromEntries(
    Object.entries(fields).flatMap(([key, field]) => {
      const value = field.read(record, key);
      if (field.required && value === undefined) {
        throw new AppError('INVALID_ARGS', `Expected ${key} to be set.`);
      }
      return value === undefined ? [] : [[key, value]];
    }),
  );
  const commonInput = readCommonInput(record, {
    readTargetAlias: !Object.hasOwn(fields, 'target'),
  });
  return compactRecord({
    ...commonInput,
    ...commonToClientOptions(commonInput),
    ...commandOptions,
  }) as InferCommandInput<TFields>;
}

function readPoint(record: Record<string, unknown>, key: string): PointInput {
  const point = readRecordField(record, key);
  return { x: requiredNumber(point, 'x'), y: requiredNumber(point, 'y') };
}

export function toRepeatedOptions(input: RepeatedInput): RepeatedInput {
  return {
    count: input.count,
    intervalMs: input.intervalMs,
    holdMs: input.holdMs,
    jitterPx: input.jitterPx,
    doubleTap: input.doubleTap,
  };
}

export function toSelectorSnapshotOptions(input: SelectorSnapshotInput): SelectorSnapshotInput {
  return {
    depth: input.depth,
    scope: input.scope,
    raw: input.raw,
  };
}

function optionalField<T>(schema: JsonSchema, read: FieldReader<T>): CommandField<T> {
  return { schema, required: false, read };
}

function integerSchemaWithBounds(
  description: string | undefined,
  options: { min?: number; max?: number },
): JsonSchema {
  return {
    ...integerSchema(description),
    ...(options.min === undefined ? {} : { minimum: options.min }),
    ...(options.max === undefined ? {} : { maximum: options.max }),
  };
}

function fieldProperties(fields: CommandFieldMap): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([, field]) => field.audience?.kind !== 'retired')
      .map(([key, field]) => [key, field.schema]),
  );
}

/** A retired field also retires the common key it shadows, such as the `target` device alias. */
function retiredFieldNames(fields: CommandFieldMap): ReadonlySet<string> {
  return new Set(
    Object.entries(fields).flatMap(([key, field]) =>
      field.audience?.kind === 'retired' ? [key] : [],
    ),
  );
}

function requiredFieldNames(fields: CommandFieldMap): string[] {
  return Object.entries(fields).flatMap(([key, field]) => (field.required ? [key] : []));
}

/** Non-model audiences declared by a command's own fields, for the surface boundaries to honor. */
export function fieldAudiences(fields: CommandFieldMap): InputAudienceMap {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, field]) =>
      field.audience ? [[key, field.audience]] : [],
    ),
  );
}

// The UI target of an interaction is named by top-level keys, the CLI's vocabulary:
// {"ref":"@e12"}, {"selector":"id=\"submit\""}, or {"x":120,"y":340}.

export type TargetedInput<TFields extends CommandFieldMap, TTarget = InteractionTarget> = Omit<
  InferCommandInput<TFields>,
  'ref' | 'label' | 'selector' | 'x' | 'y' | 'target'
> &
  TTarget;

/** The keys a minimal call example sets for a command that takes a UI target. */
export const TARGET_INPUT_EXAMPLE = { ref: '@e12' } as const;

const REF_FORM = '{"ref":"@e12"}';
const SELECTOR_FORM = String.raw`{"selector":"id=\"submit\""}`;
const ELEMENT_TARGET_FORMS = `${REF_FORM} or ${SELECTOR_FORM}`;
const INTERACTION_TARGET_FORMS = `${REF_FORM}, ${SELECTOR_FORM}, or {"x":120,"y":340}`;

/** Ref or selector, for a command that reads an element (`get`). */
export function elementTargetFields() {
  return targetFields(ELEMENT_TARGET_FORMS, 'ref or selector');
}

/** Ref, selector, or screen point, for a command that acts on the UI. */
export function interactionTargetFields() {
  return {
    ...targetFields(INTERACTION_TARGET_FORMS, 'ref, selector, or x+y'),
    x: numberField(
      'Screen x coordinate, with y. Pass exactly one of ref, selector, or x+y; use x+y only when no ref or selector is available.',
    ),
    y: numberField('Screen y coordinate, with x. Pass exactly one of ref, selector, or x+y.'),
  };
}

function targetFields(forms: string, choice: string) {
  return {
    ref: stringField(`Snapshot element ref such as @e12. Pass exactly one of ${choice}.`),
    label: stringField('Optional human label for ref.'),
    selector: stringField(
      `Selector expression such as id="submit" or label="Sign in". Pass exactly one of ${choice}.`,
    ),
    target: retiredField(`target was removed; pass the UI target at the top level: ${forms}.`),
  };
}

/** Reads a command's fields, then requires exactly one UI target among the ones they declare. */
export function readTargetedInput<
  TFields extends CommandFieldMap,
  TTarget extends InteractionTarget = InteractionTarget,
>(input: unknown, fields: TFields): TargetedInput<TFields, TTarget> {
  const { ref, label, selector, x, y, ...rest } = readFieldInput(input, fields) as Record<
    string,
    unknown
  >;
  const named = [
    ref === undefined ? [] : ['ref'],
    selector === undefined ? [] : ['selector'],
    x === undefined && y === undefined ? [] : ['x/y'],
  ].flat();
  if (named.length !== 1) {
    const forms = 'x' in fields ? INTERACTION_TARGET_FORMS : ELEMENT_TARGET_FORMS;
    throw new AppError(
      'INVALID_ARGS',
      named.length === 0
        ? 'Expected a UI target.'
        : `Expected one UI target, got ${named.join(' and ')}.`,
      { hint: `Pass exactly one of: ${forms}.` },
    );
  }
  if (label !== undefined && ref === undefined) {
    throw new AppError('INVALID_ARGS', 'label applies only with ref.', {
      hint: 'Pass label together with ref, for example {"ref":"@e12","label":"Sign in"}.',
    });
  }
  if (named[0] === 'x/y' && (x === undefined || y === undefined)) {
    throw new AppError('INVALID_ARGS', 'Expected x and y together.', {
      hint: 'Pass both screen coordinates, for example {"x":120,"y":340}.',
    });
  }
  const target = toClientInteractionTarget({ ref, label, selector, x, y } as InteractionTarget);
  return { ...rest, ...target } as TargetedInput<TFields, TTarget>;
}

/** Only the target keys, so a projection never carries another key along with them. */
export function toClientInteractionTarget<TTarget extends InteractionTarget>(
  input: TTarget,
): TTarget {
  if (input.ref !== undefined)
    return compactRecord({ ref: input.ref, label: input.label }) as TTarget;
  if (input.selector !== undefined) return { selector: input.selector } as TTarget;
  return { x: input.x, y: input.y } as TTarget;
}
