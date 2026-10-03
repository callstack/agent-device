import {
  PROVIDER_DEVICE_TYPES,
  type CloudProviderProfileFields,
  type ProviderDeviceType,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { requireProviderDeviceOrientation } from './webdriver-utils.ts';

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
>;

type TestMuDeviceFeatureSpec = {
  field: keyof TestMuDeviceFeatureFields;
  /** Key emitted inside `lt:options`. */
  capability: string;
  /** Canonical CLI flag, so an error can name a recovery action. */
  flag: string;
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
];

/** Builds the `lt:options` fragment for the configured device features. */
export function buildTestMuDeviceFeatureCapabilities(
  fields: TestMuDeviceFeatureFields,
): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  for (const spec of TESTMU_DEVICE_FEATURE_SPECS) {
    const value = fields[spec.field];
    if (value === undefined || value === '') continue;
    capabilities[spec.capability] = spec.project ? spec.project(value) : value;
  }
  return capabilities;
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
    if (typeof value !== 'string' || value.length === 0) continue;
    if (spec.field === 'providerDeviceOrientation') {
      fields.providerDeviceOrientation = requireProviderDeviceOrientation(spec, value);
      continue;
    }
    fields[spec.field] = value;
  }
  return fields;
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
