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
 * One row per input key every command accepts. The JSON schema, the readers,
 * the client-options projection, and the model-facing audience boundary are all
 * derived from this table, so adding or reclassifying a common key is a one-row
 * edit rather than a matching edit in four parallel enumerations.
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
};

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
  },
  platform: {
    schema: {
      type: 'string',
      enum: PLATFORM_SELECTORS,
      description: 'Platform selector used to resolve a device.',
    },
    read: (record) => optionalEnum(record, 'platform', PLATFORM_SELECTORS),
  },
  deviceTarget: {
    schema: {
      type: 'string',
      enum: DEVICE_TARGETS,
      description: 'Device target form. Maps to the CLI --target flag.',
    },
    read: readDeviceTarget,
    clientKey: 'target',
  },
  target: {
    // Read through `deviceTarget` above, which reconciles the two spellings.
    schema: {
      type: 'string',
      enum: DEVICE_TARGETS,
      description:
        'Alias for deviceTarget on commands without a UI target field. Interaction commands reserve target for the UI element.',
    },
  },
  device: {
    schema: {
      type: 'string',
      description: 'Device name selector (a UDID belongs in udid, a serial in serial).',
    },
    read: (record) => optionalString(record, 'device'),
  },
  udid: {
    schema: {
      type: 'string',
      description:
        'Apple device or simulator UDID; the selector that pins one device when several share a name.',
    },
    read: (record) => optionalString(record, 'udid'),
  },
  serial: {
    schema: {
      type: 'string',
      description: 'Android, HarmonyOS, or Vega VVD serial selector.',
    },
    read: (record) => optionalString(record, 'serial'),
  },
  iosSimulatorDeviceSet: {
    schema: {
      type: 'string',
      description: 'iOS simulator device-set path used for device resolution.',
    },
    read: (record) => optionalString(record, 'iosSimulatorDeviceSet'),
    audience: operatorAudience({ envFlagKeys: [], operatorConfig: true }),
  },
  iosXctestrunFile: {
    schema: {
      type: 'string',
      description: 'Externally built iOS XCTest runner .xctestrun artifact path.',
    },
    read: (record) => optionalString(record, 'iosXctestrunFile'),
    audience: ENV_OR_OPERATOR_CONFIG,
  },
  iosXctestDerivedDataPath: {
    schema: {
      type: 'string',
      description: 'Derived data path for external iOS XCTest runner execution.',
    },
    read: (record) => optionalString(record, 'iosXctestDerivedDataPath'),
    audience: ENV_OR_OPERATOR_CONFIG,
  },
  iosXctestEnvDir: {
    schema: {
      type: 'string',
      description: 'Writable directory for iOS XCTest runner env overlays.',
    },
    read: (record) => optionalString(record, 'iosXctestEnvDir'),
    audience: ENV_OR_OPERATOR_CONFIG,
  },
  androidDeviceAllowlist: {
    schema: {
      type: 'string',
      description: 'Android serial allowlist used for device resolution.',
    },
    read: (record) => optionalString(record, 'androidDeviceAllowlist'),
  },
  noRecord: {
    // Seam 2 of 3 for `--no-record` (see `commonInputFromFlags`). `readFieldInput`
    // keeps ONLY declared metadata fields plus this common input, so a flag
    // absent here is filtered out of every field-based command's input before
    // the client ever sees it.
    read: (record) => optionalBoolean(record, 'noRecord'),
  },
  daemonBaseUrl: {
    schema: { type: 'string', description: 'Remote daemon base URL.' },
    read: (record) => optionalString(record, 'daemonBaseUrl'),
    audience: ENV_OR_OPERATOR_CONFIG,
  },
  daemonAuthToken: {
    schema: { type: 'string', description: 'Remote daemon auth token.' },
    read: (record) => optionalString(record, 'daemonAuthToken'),
    audience: ENV_OR_OPERATOR_CONFIG,
  },
  tenant: {
    schema: { type: 'string', description: 'Remote tenant identifier.' },
    read: (record) => optionalString(record, 'tenant'),
  },
  runId: {
    schema: { type: 'string', description: 'Lease run identifier.' },
    read: (record) => optionalString(record, 'runId'),
  },
  leaseId: {
    schema: { type: 'string', description: 'Existing lease identifier.' },
    read: (record) => optionalString(record, 'leaseId'),
  },
  cwd: {
    schema: { type: 'string', description: 'Working directory for command execution.' },
    read: (record) => optionalString(record, 'cwd'),
    audience: operatorAudience({
      operatorPath:
        'Start the process serving these tools in the desired working directory, or pass absolute paths.',
    }),
  },
  debug: {
    schema: { type: 'boolean', description: 'Enable debug diagnostics.' },
    read: (record) => optionalBoolean(record, 'debug'),
  },
} as const satisfies Record<keyof CommonCommandInput | 'target', CommonInputFieldSpec>;

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
    // Seam 3 of 3 for `--no-record` (see `commonInputFromFlags`). Every
    // `to*Options` projection (`toPressOptions`, `toGetOptions`, ...) rebuilds
    // the client options object from this helper plus its own named fields, so
    // a key absent here is dropped even when the reader forwarded it and
    // `readCommonInput` kept it.
    options[field.clientKey ?? key] = input[key as keyof CommonCommandInput];
  }
  return compactRecord(options) as AgentDeviceRequestOverrides & AgentDeviceSelectionOptions;
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
