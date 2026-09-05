import type { CliFlags } from '@agent-device/contracts/command';
import type {
  AgentDeviceRequestOverrides,
  AgentDeviceSelectionOptions,
} from '@agent-device/contracts/client';
import {
  DEVICE_TARGETS,
  PLATFORM_SELECTORS,
  type DeviceTarget,
  type PlatformSelector,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { JsonSchema } from './command-contract.ts';
import { operatorAudience, type InputAudience, type InputAudienceMap } from './input-audience.ts';
import { compactRecord, optionalBoolean, optionalEnum, optionalString } from './input-readers.ts';

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
  /** `--no-record`: common to every recordable command (see `commonInputFromFlags`). */
  noRecord?: boolean;
};

export type CommonInputReadOptions = { readTargetAlias?: boolean };

/**
 * `cli-grammar/common.ts`'s two flag-derived projections a row can join:
 * `input` is the reader-input shape (`commonInputFromFlags`, compacted), `selection` is the
 * client-options shape kept by `is`/`find`/`wait`/`settings` (`selectionOptionsFromFlags`,
 * not compacted). A row absent from both is never read off `CliFlags` at all.
 */
export type CommonFlagProjection = 'input' | 'selection';

/**
 * One row per input key every command accepts. The JSON schema, the readers,
 * the client-options projection, the model-facing audience boundary, and the two
 * flag-derived projections below are all derived from this table, so adding or
 * reclassifying a common key is a one-row edit rather than a matching edit across
 * parallel enumerations.
 */
type CommonInputFieldSpec = {
  /** Advertised property. Absent for a key each command schema carries itself (`noRecord`). */
  schema?: JsonSchema;
  /** Absent for a schema-only alias, whose value another row's reader picks up. */
  read?: (record: Record<string, unknown>, options: CommonInputReadOptions) => unknown;
  /** Client-options key, when the projection renames it. */
  clientKey?: string;
  /** Who may write the key. Absent means the model — see `input-audience.ts`. */
  audience?: InputAudience;
} & (
  | {
      /** Which of `cli-grammar/common.ts`'s flag-derived projections include this row. */
      flagIn: readonly CommonFlagProjection[];
      /**
       * The `CliFlags` property this row reads, when its spelling differs (e.g. `deviceTarget`
       * reads `flags.target`) or matches outright.
       */
      flagKey: keyof CliFlags;
    }
  | { flagIn: readonly []; flagKey?: undefined }
);

/**
 * The common operator shape: the value comes from the key's own environment
 * variable or its `~/.agent-device/config.json` entry. It covers both kinds of
 * operator-owned common key — the credential and the endpoint it is sent to
 * (a model-writable `daemonBaseUrl` would redirect the env-resolved
 * `daemonAuthToken` to an arbitrary server), and the build and device-set paths,
 * which select operator infrastructure rather than per-call work.
 */
const ENV_OR_OPERATOR_CONFIG = operatorAudience({ operatorConfig: true });

const COMMON_INPUT_FIELDS = {
  session: {
    schema: { type: 'string', description: 'Agent-device session name.' },
    read: (record) => optionalString(record, 'session'),
    flagKey: 'session',
    flagIn: ['input'],
  },
  platform: {
    schema: {
      type: 'string',
      enum: PLATFORM_SELECTORS,
      description: 'Platform selector used to resolve a device.',
    },
    read: (record) => optionalEnum(record, 'platform', PLATFORM_SELECTORS),
    flagKey: 'platform',
    flagIn: ['input', 'selection'],
  },
  deviceTarget: {
    schema: {
      type: 'string',
      enum: DEVICE_TARGETS,
      description: 'Device target form. Maps to the CLI --target flag.',
    },
    read: readDeviceTarget,
    clientKey: 'target',
    flagKey: 'target',
    flagIn: ['input', 'selection'],
  },
  target: {
    // Read through `deviceTarget` above, which reconciles the two spellings.
    schema: {
      type: 'string',
      enum: DEVICE_TARGETS,
      description:
        'Alias for deviceTarget on commands without a UI target field. Interaction commands reserve target for the UI element.',
    },
    flagIn: [],
  },
  device: {
    schema: {
      type: 'string',
      description: 'Device name selector (a UDID belongs in udid, a serial in serial).',
    },
    read: (record) => optionalString(record, 'device'),
    flagKey: 'device',
    flagIn: ['input', 'selection'],
  },
  udid: {
    schema: {
      type: 'string',
      description:
        'Apple device or simulator UDID; the selector that pins one device when several share a name.',
    },
    read: (record) => optionalString(record, 'udid'),
    flagKey: 'udid',
    flagIn: ['input', 'selection'],
  },
  serial: {
    schema: {
      type: 'string',
      description: 'Android, HarmonyOS, or Vega VVD serial selector.',
    },
    read: (record) => optionalString(record, 'serial'),
    flagKey: 'serial',
    flagIn: ['input', 'selection'],
  },
  iosSimulatorDeviceSet: {
    schema: {
      type: 'string',
      description: 'iOS simulator device-set path used for device resolution.',
    },
    read: (record) => optionalString(record, 'iosSimulatorDeviceSet'),
    audience: operatorAudience({ envFlagKeys: [], operatorConfig: true }),
    flagKey: 'iosSimulatorDeviceSet',
    flagIn: ['input', 'selection'],
  },
  iosXctestrunFile: {
    schema: {
      type: 'string',
      description: 'Externally built iOS XCTest runner .xctestrun artifact path.',
    },
    read: (record) => optionalString(record, 'iosXctestrunFile'),
    audience: ENV_OR_OPERATOR_CONFIG,
    flagKey: 'iosXctestrunFile',
    flagIn: ['input'],
  },
  iosXctestDerivedDataPath: {
    schema: {
      type: 'string',
      description: 'Derived data path for external iOS XCTest runner execution.',
    },
    read: (record) => optionalString(record, 'iosXctestDerivedDataPath'),
    audience: ENV_OR_OPERATOR_CONFIG,
    flagKey: 'iosXctestDerivedDataPath',
    flagIn: ['input'],
  },
  iosXctestEnvDir: {
    schema: {
      type: 'string',
      description: 'Writable directory for iOS XCTest runner env overlays.',
    },
    read: (record) => optionalString(record, 'iosXctestEnvDir'),
    audience: ENV_OR_OPERATOR_CONFIG,
    flagKey: 'iosXctestEnvDir',
    flagIn: ['input'],
  },
  androidDeviceAllowlist: {
    schema: {
      type: 'string',
      description: 'Android serial allowlist used for device resolution.',
    },
    read: (record) => optionalString(record, 'androidDeviceAllowlist'),
    flagKey: 'androidDeviceAllowlist',
    flagIn: ['input', 'selection'],
  },
  noRecord: {
    // `readFieldInput` keeps ONLY declared metadata fields plus this common
    // input, so a flag absent here is filtered out of every field-based
    // command's input before the client ever sees it (#1304/#1305, #1311, #1313).
    read: (record) => optionalBoolean(record, 'noRecord'),
    flagKey: 'noRecord',
    flagIn: ['input', 'selection'],
  },
  daemonBaseUrl: {
    schema: { type: 'string', description: 'Remote daemon base URL.' },
    read: (record) => optionalString(record, 'daemonBaseUrl'),
    audience: ENV_OR_OPERATOR_CONFIG,
    flagIn: [],
  },
  daemonAuthToken: {
    schema: { type: 'string', description: 'Remote daemon auth token.' },
    read: (record) => optionalString(record, 'daemonAuthToken'),
    audience: ENV_OR_OPERATOR_CONFIG,
    flagIn: [],
  },
  tenant: {
    schema: { type: 'string', description: 'Remote tenant identifier.' },
    read: (record) => optionalString(record, 'tenant'),
    flagIn: [],
  },
  runId: {
    schema: { type: 'string', description: 'Lease run identifier.' },
    read: (record) => optionalString(record, 'runId'),
    flagIn: [],
  },
  leaseId: {
    schema: { type: 'string', description: 'Existing lease identifier.' },
    read: (record) => optionalString(record, 'leaseId'),
    flagIn: [],
  },
  cwd: {
    schema: { type: 'string', description: 'Working directory for command execution.' },
    read: (record) => optionalString(record, 'cwd'),
    audience: operatorAudience({
      operatorPath:
        'Start the process serving these tools in the desired working directory, or pass absolute paths.',
    }),
    flagIn: [],
  },
  debug: {
    schema: { type: 'boolean', description: 'Enable debug diagnostics.' },
    read: (record) => optionalBoolean(record, 'debug'),
    flagIn: [],
  },
} as const satisfies Record<keyof CommonCommandInput | 'target', CommonInputFieldSpec>;

/** The table's row type, keyed by row name — lets other modules derive types from it (e.g. `SelectionOptions`). */
export type CommonInputFieldsTable = typeof COMMON_INPUT_FIELDS;

const COMMON_INPUT_ROWS: ReadonlyArray<readonly [string, CommonInputFieldSpec]> =
  Object.entries(COMMON_INPUT_FIELDS);

/** Common keys no model-facing tool schema advertises or admits. */
export const COMMON_INPUT_AUDIENCE: InputAudienceMap = Object.fromEntries(
  COMMON_INPUT_ROWS.flatMap(([key, field]) => (field.audience ? [[key, field.audience]] : [])),
);

export function commonProperties(): Record<string, JsonSchema> {
  return Object.fromEntries(
    COMMON_INPUT_ROWS.flatMap(([key, field]) => (field.schema ? [[key, field.schema]] : [])),
  );
}

export function readCommonInput(
  record: Record<string, unknown>,
  options: CommonInputReadOptions = {},
): CommonCommandInput {
  const input: Record<string, unknown> = {};
  for (const [key, field] of COMMON_INPUT_ROWS) {
    if (!field.read) continue;
    input[key] = field.read(record, options);
  }
  return input as CommonCommandInput;
}

export function commonToClientOptions(
  input: CommonCommandInput,
): AgentDeviceRequestOverrides & AgentDeviceSelectionOptions {
  const options: Record<string, unknown> = {};
  for (const [key, field] of COMMON_INPUT_ROWS) {
    if (!field.read) continue;
    // Every `to*Options` projection (`toPressOptions`, `toGetOptions`, ...)
    // rebuilds the client options object from this helper plus its own named
    // fields, so a key absent from the table is dropped here even when the
    // reader forwarded it and `readCommonInput` kept it (#1304/#1305).
    options[field.clientKey ?? key] = input[key as keyof CommonCommandInput];
  }
  return compactRecord(options) as AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;
}

/**
 * `cli-grammar/common.ts`'s two `CliFlags` readers (`commonInputFromFlags`,
 * `selectionOptionsFromFlags`) project this same table instead of restating
 * their key lists: a row joins a projection only when `flagIn` names it, and
 * its output key is the row key for `input`, or `clientKey ?? key` for
 * `selection` — the same renaming `commonToClientOptions` already applies.
 */
export function commonFlagProjection(
  flags: CliFlags,
  projection: CommonFlagProjection,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const [key, field] of COMMON_INPUT_ROWS) {
    if (field.flagKey === undefined || !field.flagIn.includes(projection)) continue;
    const outputKey = projection === 'selection' ? (field.clientKey ?? key) : key;
    options[outputKey] = flags[field.flagKey];
  }
  return options;
}

function readDeviceTarget(
  record: Record<string, unknown>,
  options: CommonInputReadOptions,
): DeviceTarget | undefined {
  const deviceTarget = optionalEnum(record, 'deviceTarget', DEVICE_TARGETS);
  if (options.readTargetAlias === false || record.target === undefined) return deviceTarget;
  const targetAlias = optionalEnum(record, 'target', DEVICE_TARGETS);
  if (deviceTarget !== undefined && targetAlias !== deviceTarget) {
    throw new AppError(
      'INVALID_ARGS',
      'Expected target alias to match deviceTarget when both are set.',
    );
  }
  return deviceTarget ?? targetAlias;
}
