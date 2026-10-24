import {
  PROVIDER_DEVICE_TYPES,
  type CloudProviderProfileFields,
  type ProviderDeviceType,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { requireProviderDeviceOrientation } from '@agent-device/provider-webdriver/plugin';

/**
 * TestMu "device feature" session capabilities: the hosted-provider flags TestMu can act on,
 * projected onto their `lt:options` keys. The table is the contract; adding a capability means
 * adding a row, not a branch.
 */
export type TestMuDeviceFeatureFields = Pick<
  CloudProviderProfileFields,
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerAppiumVersion'
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkLogs'
>;

type TestMuDeviceFeatureSpec = {
  field: keyof TestMuDeviceFeatureFields;
  /** Key emitted inside `lt:options`. */
  capability: string;
  /** Canonical CLI flag, so an error can name a recovery action. */
  flag: string;
  /** Set on a boolean opt-in row: the flag's presence is the whole instruction. */
  boolean?: true;
  /** For a capture opt-in: the options key that carries the capture's own settings. */
  optionsCapability?: string;
  /** Projects the validated flag value onto what the hub expects. */
  project?: (value: string) => unknown;
};

export const TESTMU_DEVICE_FEATURE_SPECS: readonly TestMuDeviceFeatureSpec[] = [
  {
    field: 'providerDeviceOrientation',
    capability: 'deviceOrientation',
    flag: '--provider-device-orientation',
    // The hub matches the orientation enum case-sensitively in upper case.
    project: (value) => value.toUpperCase(),
  },
  { field: 'providerGeoLocation', capability: 'geoLocation', flag: '--provider-geo-location' },
  { field: 'providerTimezone', capability: 'timezone', flag: '--provider-timezone' },
  {
    field: 'providerAppiumVersion',
    capability: 'appiumVersion',
    flag: '--provider-appium-version',
  },
  { field: 'providerLanguage', capability: 'language', flag: '--provider-language' },
  { field: 'providerLocale', capability: 'locale', flag: '--provider-locale' },
  {
    // TestMu captures session traffic through its proxy and publishes the HAR on the session record
    // once the session ends, so this opts into a post-session artifact rather than a live source.
    field: 'providerNetworkLogs',
    capability: 'network',
    flag: '--provider-network-logs',
    boolean: true,
    optionsCapability: 'networkLogsOptions',
  },
];

/** Builds the `lt:options` fragment for the configured device features. */
export function buildTestMuDeviceFeatureCapabilities(
  fields: TestMuDeviceFeatureFields,
): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  for (const spec of TESTMU_DEVICE_FEATURE_SPECS) {
    if (spec.boolean) {
      if (fields[spec.field] !== true) continue;
      capabilities[spec.capability] = true;
      if (spec.optionsCapability) capabilities[spec.optionsCapability] = { captureContent: true };
      continue;
    }
    const value = stringFeatureValue(fields, spec);
    if (value === undefined) continue;
    capabilities[spec.capability] = spec.project ? spec.project(value) : value;
  }
  return capabilities;
}

/** The string-valued rows carry no boolean flag, so their field reads as a string or nothing. */
function stringFeatureValue(
  fields: TestMuDeviceFeatureFields,
  spec: TestMuDeviceFeatureSpec,
): string | undefined {
  const value = fields[spec.field];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

/**
 * Reads device-feature fields off an untyped flag bag (a daemon request). Enum values are
 * validated here rather than forwarded to the hub, where an unrecognized value is ignored.
 */
export function readTestMuDeviceFeatureFields(
  flags: Record<string, unknown> | undefined,
): TestMuDeviceFeatureFields {
  const fields: TestMuDeviceFeatureFields = {};
  for (const spec of TESTMU_DEVICE_FEATURE_SPECS) {
    const value = flags?.[spec.field];
    if (spec.boolean) {
      if (value === true) assignBooleanFeatureField(fields, spec);
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) continue;
    if (spec.field === 'providerDeviceOrientation') {
      fields.providerDeviceOrientation = requireProviderDeviceOrientation(spec, value);
      continue;
    }
    if (spec.field === 'providerNetworkLogs') continue;
    fields[spec.field] = value;
  }
  return fields;
}

function assignBooleanFeatureField(
  fields: TestMuDeviceFeatureFields,
  spec: TestMuDeviceFeatureSpec,
): void {
  if (spec.field === 'providerNetworkLogs') fields.providerNetworkLogs = true;
}

/** Reads the TestMu device pool off an untyped flag bag; an unset value keeps the virtual pool. */
export function readTestMuDeviceType(
  flags: Record<string, unknown> | undefined,
): ProviderDeviceType {
  const value = flags?.providerDeviceType;
  if (value === undefined || value === '') return 'virtual';
  const match = PROVIDER_DEVICE_TYPES.find((deviceType) => deviceType === value);
  if (match) return match;
  throw new AppError('INVALID_ARGS', `Invalid --provider-device-type value: ${String(value)}.`, {
    hint: `Use ${PROVIDER_DEVICE_TYPES.join('|')}.`,
    flag: '--provider-device-type',
  });
}
