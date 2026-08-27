import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
  ElementTarget,
  InteractionTarget,
} from '@agent-device/contracts/client';
import {
  readOptionalInteger as optionalInteger,
  readOptionalNumber as optionalNumberValue,
} from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import type { RepeatedInput } from '@agent-device/contracts/interaction';
import type { JsonSchema } from './command-contract.ts';
import {
  commonProperties,
  commonToClientOptions,
  readCommonInput,
  type CommonCommandInput,
} from './common-input-fields.ts';
import type { InputAudience, InputAudienceMap, OperatorInputSource } from './input-audience.ts';
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
  requiredEnum,
  requiredNumber,
  requiredString,
} from './input-readers.ts';

const INTERACTION_TARGET_KINDS = ['ref', 'selector', 'point'] as const;

export type InteractionTargetInput =
  | { kind: 'ref'; ref: string; label?: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'point'; x: number; y: number };

export type ElementTargetInput =
  | { kind: 'ref'; ref: string; label?: string }
  | { kind: 'selector'; selector: string };

export type SelectorSnapshotInput = {
  depth?: number;
  scope?: string;
  raw?: boolean;
};

export type PointInput = { x: number; y: number };

function commandInputSchema(
  properties: Record<string, JsonSchema>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: 'object',
    properties: {
      ...commonProperties(),
      ...properties,
    },
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
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

function enumSchema(values: readonly string[], description?: string): JsonSchema {
  return { type: 'string', enum: values, ...(description ? { description } : {}) };
}

export function stringSchema(description?: string): JsonSchema {
  return { type: 'string', ...(description ? { description } : {}) };
}

function numberSchema(
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

function stringArraySchema(description?: string): JsonSchema {
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
    read: (record, key) => {
      if (Object.hasOwn(record, key)) {
        throw new AppError('INVALID_ARGS', message);
      }
      return undefined;
    },
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

export function interactionTargetField(): CommandField<InteractionTargetInput> {
  return optionalField(interactionTargetSchema(), (record, key) =>
    record[key] === undefined ? undefined : readInteractionTarget(record, key),
  );
}

export function elementTargetField(): CommandField<ElementTargetInput> {
  return optionalField(elementTargetSchema(), (record, key) =>
    record[key] === undefined ? undefined : readElementTarget(record, key),
  );
}

export function pointField(description: string): CommandField<PointInput> {
  return optionalField(pointSchema(description), (record, key) =>
    record[key] === undefined ? undefined : readPoint(record, key),
  );
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
    jitterPx: integerField('Randomization radius in pixels.', { min: 0 }),
    doubleTap: booleanField('Request a double-tap action.'),
  };
}

export function fieldsInputSchema(fields: CommandFieldMap): JsonSchema {
  return commandInputSchema(fieldProperties(fields), requiredFieldNames(fields));
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

function readInteractionTarget(
  record: Record<string, unknown>,
  key: string,
): InteractionTargetInput {
  const target = readRecordField(record, key);
  const kind = requiredEnum(target, 'kind', INTERACTION_TARGET_KINDS);
  switch (kind) {
    case 'ref':
      return {
        kind,
        ref: requiredString(target, 'ref'),
        label: optionalString(target, 'label'),
      };
    case 'selector':
      return { kind, selector: requiredString(target, 'selector') };
    case 'point':
      return {
        kind,
        x: requiredNumber(target, 'x'),
        y: requiredNumber(target, 'y'),
      };
  }
}

function readElementTarget(record: Record<string, unknown>, key: string): ElementTargetInput {
  const target = readRecordField(record, key);
  const kind = requiredEnum(target, 'kind', ['ref', 'selector'] as const);
  if (kind === 'ref') {
    return {
      kind,
      ref: requiredString(target, 'ref'),
      label: optionalString(target, 'label'),
    };
  }
  return { kind, selector: requiredString(target, 'selector') };
}

function readPoint(record: Record<string, unknown>, key: string): PointInput {
  const point = readRecordField(record, key);
  return { x: requiredNumber(point, 'x'), y: requiredNumber(point, 'y') };
}

export function toClientInteractionTarget(target: InteractionTargetInput): InteractionTarget {
  switch (target.kind) {
    case 'ref':
      return { ref: target.ref, label: target.label };
    case 'selector':
      return { selector: target.selector };
    case 'point':
      return { x: target.x, y: target.y };
  }
}

export function toClientElementTarget(target: ElementTargetInput): ElementTarget {
  switch (target.kind) {
    case 'ref':
      return { ref: target.ref, label: target.label };
    case 'selector':
      return { selector: target.selector };
  }
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

function interactionTargetSchema(): JsonSchema {
  return {
    oneOf: [
      ...elementTargetSchemaVariants(),
      {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'point' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['kind', 'x', 'y'],
        additionalProperties: false,
      },
    ],
    description: 'UI target. This is separate from deviceTarget, which selects the device form.',
  };
}

function elementTargetSchema(): JsonSchema {
  return {
    oneOf: elementTargetSchemaVariants(),
    description: 'UI element target by snapshot ref or selector expression.',
  };
}

function elementTargetSchemaVariants(): JsonSchema[] {
  return [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'ref' },
        ref: { type: 'string', description: 'Snapshot element ref such as @e12.' },
        label: { type: 'string', description: 'Optional human label for the ref.' },
      },
      required: ['kind', 'ref'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'selector' },
        selector: { type: 'string', description: 'Agent-device selector expression.' },
      },
      required: ['kind', 'selector'],
      additionalProperties: false,
    },
  ];
}
