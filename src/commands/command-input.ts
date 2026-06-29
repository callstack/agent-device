import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
  ElementTarget,
  InteractionTarget,
} from '../client-types.ts';
import {
  DEVICE_TARGETS,
  PLATFORM_SELECTORS,
  type DeviceTarget,
  type PlatformSelector,
} from '../kernel/device.ts';
import type { JsonSchema } from './command-contract.ts';

const INTERACTION_TARGET_KINDS = ['ref', 'selector', 'point'] as const;

export type CommonCommandInput = Pick<
  AgentDeviceRequestOverrides,
  'session' | 'daemonBaseUrl' | 'daemonAuthToken' | 'tenant' | 'runId' | 'leaseId' | 'cwd' | 'debug'
> & {
  platform?: PlatformSelector;
  deviceTarget?: DeviceTarget;
  device?: string;
  udid?: string;
  serial?: string;
  iosSimulatorDeviceSet?: string;
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
  androidDeviceAllowlist?: string;
};

export type InteractionTargetInput =
  | { kind: 'ref'; ref: string; label?: string }
  | { kind: 'selector'; selector: string }
  | { kind: 'point'; x: number; y: number };

export type ElementTargetInput =
  | { kind: 'ref'; ref: string; label?: string }
  | { kind: 'selector'; selector: string };

export type RepeatedInput = {
  count?: number;
  intervalMs?: number;
  holdMs?: number;
  jitterPx?: number;
  doubleTap?: boolean;
};

export type SelectorSnapshotInput = {
  depth?: number;
  scope?: string;
  raw?: boolean;
};

export type PointInput = { x: number; y: number };
type CommonInputOptions = { readTargetAlias?: boolean };

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

function numberSchema(description?: string): JsonSchema {
  return { type: 'number', ...(description ? { description } : {}) };
}

export function integerSchema(description?: string): JsonSchema {
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
};

export type CommandFieldMap = Record<string, CommandField<unknown>>;

export type InferCommandFields<TFields extends CommandFieldMap> = {
  [TKey in keyof TFields as TFields[TKey]['required'] extends true
    ? TKey
    : never]: TFields[TKey] extends CommandField<infer TValue> ? TValue : never;
} & {
  [TKey in keyof TFields as TFields[TKey]['required'] extends true
    ? never
    : TKey]?: TFields[TKey] extends CommandField<infer TValue> ? TValue : never;
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

export function stringField(description?: string): CommandField<string> {
  return optionalField(stringSchema(description), optionalString);
}

export function numberField(description?: string): CommandField<number> {
  return optionalField(numberSchema(description), optionalNumberValue);
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
        throw new Error(`Expected ${key} to be set.`);
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

export function readInputRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Expected object arguments.');
  }
  return input as Record<string, unknown>;
}

export function readCommonInput(
  record: Record<string, unknown>,
  options: CommonInputOptions = {},
): CommonCommandInput {
  return {
    session: optionalString(record, 'session'),
    platform: optionalEnum(record, 'platform', PLATFORM_SELECTORS),
    deviceTarget: readDeviceTarget(record, options),
    device: optionalString(record, 'device'),
    udid: optionalString(record, 'udid'),
    serial: optionalString(record, 'serial'),
    iosSimulatorDeviceSet: optionalString(record, 'iosSimulatorDeviceSet'),
    iosXctestrunFile: optionalString(record, 'iosXctestrunFile'),
    iosXctestDerivedDataPath: optionalString(record, 'iosXctestDerivedDataPath'),
    iosXctestEnvDir: optionalString(record, 'iosXctestEnvDir'),
    androidDeviceAllowlist: optionalString(record, 'androidDeviceAllowlist'),
    daemonBaseUrl: optionalString(record, 'daemonBaseUrl'),
    daemonAuthToken: optionalString(record, 'daemonAuthToken'),
    tenant: optionalString(record, 'tenant'),
    runId: optionalString(record, 'runId'),
    leaseId: optionalString(record, 'leaseId'),
    cwd: optionalString(record, 'cwd'),
    debug: optionalBoolean(record, 'debug'),
  };
}

function readDeviceTarget(
  record: Record<string, unknown>,
  options: CommonInputOptions,
): DeviceTarget | undefined {
  const deviceTarget = optionalEnum(record, 'deviceTarget', DEVICE_TARGETS);
  if (options.readTargetAlias === false || record.target === undefined) return deviceTarget;
  const targetAlias = optionalEnum(record, 'target', DEVICE_TARGETS);
  if (deviceTarget !== undefined && targetAlias !== deviceTarget) {
    throw new Error('Expected target alias to match deviceTarget when both are set.');
  }
  return deviceTarget ?? targetAlias;
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

export function readPoint(record: Record<string, unknown>, key: string): PointInput {
  const point = readRecordField(record, key);
  return { x: requiredNumber(point, 'x'), y: requiredNumber(point, 'y') };
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected ${key} to be a non-empty string.`);
  }
  return value;
}

export function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be a finite number.`);
  }
  return value;
}

function optionalNumberValue(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected ${key} to be a finite number.`);
  }
  return value;
}

export function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`Expected ${key} to be an integer.`);
  }
  const numberValue = value as number;
  if (options.min !== undefined && numberValue < options.min) {
    throw new Error(`Expected ${key} to be at least ${options.min}.`);
  }
  if (options.max !== undefined && numberValue > options.max) {
    throw new Error(`Expected ${key} to be at most ${options.max}.`);
  }
  return numberValue;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Expected ${key} to be a boolean.`);
  }
  return value;
}

export function requiredEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = record[key];
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Expected ${key} to be one of: ${values.join(', ')}.`);
  }
  return value;
}

export function optionalEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Expected ${key} to be one of: ${values.join(', ')}.`);
  }
  return value;
}

export function commonToClientOptions(
  input: CommonCommandInput,
): AgentDeviceRequestOverrides & AgentDeviceSelectionOptions {
  return compactRecord({
    session: input.session,
    platform: input.platform,
    target: input.deviceTarget,
    device: input.device,
    udid: input.udid,
    serial: input.serial,
    iosSimulatorDeviceSet: input.iosSimulatorDeviceSet,
    iosXctestrunFile: input.iosXctestrunFile,
    iosXctestDerivedDataPath: input.iosXctestDerivedDataPath,
    iosXctestEnvDir: input.iosXctestEnvDir,
    androidDeviceAllowlist: input.androidDeviceAllowlist,
    daemonBaseUrl: input.daemonBaseUrl,
    daemonAuthToken: input.daemonAuthToken,
    tenant: input.tenant,
    runId: input.runId,
    leaseId: input.leaseId,
    cwd: input.cwd,
    debug: input.debug,
  }) as AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;
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

export function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${label} has unknown field(s): ${unknownKeys.join(', ')}.`);
  }
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
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
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.schema]));
}

function requiredFieldNames(fields: CommandFieldMap): string[] {
  return Object.entries(fields).flatMap(([key, field]) => (field.required ? [key] : []));
}

function optionalRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Expected ${key} to be an array of strings.`);
  }
  return value as string[];
}

function commonProperties(): Record<string, JsonSchema> {
  return {
    session: { type: 'string', description: 'Agent-device session name.' },
    platform: {
      type: 'string',
      enum: PLATFORM_SELECTORS,
      description: 'Platform selector used to resolve a device.',
    },
    deviceTarget: {
      type: 'string',
      enum: DEVICE_TARGETS,
      description: 'Device target form. Maps to the CLI --target flag.',
    },
    target: {
      type: 'string',
      enum: DEVICE_TARGETS,
      description:
        'Alias for deviceTarget on commands without a UI target field. Interaction commands reserve target for the UI element.',
    },
    device: { type: 'string', description: 'Device name selector.' },
    udid: { type: 'string', description: 'iOS device UDID selector.' },
    serial: { type: 'string', description: 'Android serial selector.' },
    iosSimulatorDeviceSet: {
      type: 'string',
      description: 'iOS simulator device-set path used for device resolution.',
    },
    iosXctestrunFile: {
      type: 'string',
      description: 'Externally built iOS XCTest runner .xctestrun artifact path.',
    },
    iosXctestDerivedDataPath: {
      type: 'string',
      description: 'Derived data path for external iOS XCTest runner execution.',
    },
    iosXctestEnvDir: {
      type: 'string',
      description: 'Writable directory for iOS XCTest runner env overlays.',
    },
    androidDeviceAllowlist: {
      type: 'string',
      description: 'Android serial allowlist used for device resolution.',
    },
    daemonBaseUrl: { type: 'string', description: 'Remote daemon base URL.' },
    daemonAuthToken: { type: 'string', description: 'Remote daemon auth token.' },
    tenant: { type: 'string', description: 'Remote tenant identifier.' },
    runId: { type: 'string', description: 'Lease run identifier.' },
    leaseId: { type: 'string', description: 'Existing lease identifier.' },
    cwd: { type: 'string', description: 'Working directory for command execution.' },
    debug: { type: 'boolean', description: 'Enable debug diagnostics.' },
  };
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

function readRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an object.`);
  }
  return value as Record<string, unknown>;
}
