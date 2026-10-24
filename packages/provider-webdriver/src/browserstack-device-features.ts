import {
  PROVIDER_DEVICE_ORIENTATIONS,
  PROVIDER_PROFILE_FIELD_FLAGS,
  type CloudProviderProfileFields,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { requireProviderDeviceOrientation } from './webdriver-utils.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

/**
 * BrowserStack "device feature" session capabilities.
 *
 * These are vendor capabilities: on the W3C wire they belong inside `bstack:options`, not at the
 * top level. BrowserStack's YAML config lists them unnested and its SDK moves them — agent-device
 * talks to the hub directly, so it nests them here.
 *
 * The table is the contract. Adding a capability means adding a spec row, not a branch in the
 * capability builder or the flag reader.
 */
export type BrowserStackDeviceFeatureFields = Pick<
  CloudProviderProfileFields,
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerAppiumVersion'
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkProfile'
  | 'providerCustomNetwork'
  | 'providerNoResignApp'
  | 'providerNetworkLogs'
>;

type BrowserStackDeviceFeatureSpec = {
  /** `CliFlags`/profile field this capability is configured from. */
  field: keyof BrowserStackDeviceFeatureFields;
  /** Key emitted inside `bstack:options`. */
  capability: string;
  /** Canonical CLI flag, read from `PROVIDER_PROFILE_FIELD_FLAGS`. */
  flag: string;
  /**
   * `negated-boolean` is a flag whose presence means "turn the capability off" — BrowserStack
   * defaults `resignApp` to true, so the only useful instruction is the opt-out.
   * `capture-boolean` is a flag whose presence turns a capture on and also asks for the payloads:
   * BrowserStack reports HAR metadata unless `networkLogsOptions.captureContent` says otherwise.
   */
  type: 'string' | 'enum' | 'negated-boolean' | 'capture-boolean';
  /** For `capture-boolean`: the options key that carries the capture's own settings. */
  optionsCapability?: string;
  enumValues?: readonly string[];
  /** Platform the capability applies to; absent means both. */
  platform?: CloudWebDriverPlatform;
};

const BROWSERSTACK_DEVICE_FEATURE_ROWS: readonly Omit<BrowserStackDeviceFeatureSpec, 'flag'>[] = [
  {
    field: 'providerDeviceOrientation',
    capability: 'deviceOrientation',
    type: 'enum',
    enumValues: PROVIDER_DEVICE_ORIENTATIONS,
  },
  {
    field: 'providerGeoLocation',
    capability: 'geoLocation',
    type: 'string',
  },
  {
    field: 'providerTimezone',
    capability: 'timezone',
    type: 'string',
  },
  {
    // BrowserStack defaults to Appium 1.x when unset; `mobile:` commands the interactor issues
    // (deepLink, pressButton, activateApp) need a 2.x+ server.
    field: 'providerAppiumVersion',
    capability: 'appiumVersion',
    type: 'string',
  },
  {
    field: 'providerLanguage',
    capability: 'language',
    type: 'string',
  },
  {
    field: 'providerLocale',
    capability: 'locale',
    type: 'string',
  },
  {
    field: 'providerNetworkProfile',
    capability: 'networkProfile',
    type: 'string',
  },
  {
    field: 'providerCustomNetwork',
    capability: 'customNetwork',
    type: 'string',
  },
  {
    // BrowserStack re-signs uploaded iOS apps with its own provisioning profile, which strips
    // entitlements. Opting out keeps entitlement-dependent features (push notifications) testable.
    field: 'providerNoResignApp',
    capability: 'resignApp',
    type: 'negated-boolean',
    platform: 'ios',
  },
  {
    // BrowserStack captures session traffic through its own proxy and publishes it as a HAR once the
    // session ends, so this opts into a post-session artifact rather than a live source.
    field: 'providerNetworkLogs',
    capability: 'networkLogs',
    optionsCapability: 'networkLogsOptions',
    type: 'capture-boolean',
  },
];

export const BROWSERSTACK_DEVICE_FEATURE_SPECS: readonly BrowserStackDeviceFeatureSpec[] =
  BROWSERSTACK_DEVICE_FEATURE_ROWS.map((row) => ({
    ...row,
    flag: PROVIDER_PROFILE_FIELD_FLAGS[row.field],
  }));

/**
 * Builds the `bstack:options` fragment for the configured device features.
 *
 * Rejects combinations BrowserStack cannot act on unambiguously, so a failure names a flag rather
 * than surfacing as a silently ignored capability on a remote device.
 */
export function buildBrowserStackDeviceFeatureCapabilities(
  fields: BrowserStackDeviceFeatureFields,
  platform: CloudWebDriverPlatform,
): Record<string, unknown> {
  requireCompatibleNetworkFields(fields);
  const capabilities: Record<string, unknown> = {};
  for (const spec of BROWSERSTACK_DEVICE_FEATURE_SPECS) {
    const value = fields[spec.field];
    if (value === undefined || value === false || value === '') continue;
    requireSupportedPlatform(spec, platform);
    if (spec.type === 'negated-boolean') {
      capabilities[spec.capability] = false;
      continue;
    }
    capabilities[spec.capability] = value;
    if (spec.type === 'capture-boolean' && spec.optionsCapability) {
      capabilities[spec.optionsCapability] = { captureContent: true };
    }
  }
  return capabilities;
}

/**
 * Reads device-feature fields off an untyped flag bag (a daemon request), so the daemon-side
 * capability build and the CLI-side profile build stay driven by the same table.
 *
 * This is a trust boundary: enum values are validated here rather than forwarded to the hub, where
 * an unrecognized value is accepted and then ignored.
 */
export function readBrowserStackDeviceFeatureFields(
  flags: Record<string, unknown> | undefined,
): BrowserStackDeviceFeatureFields {
  const fields: BrowserStackDeviceFeatureFields = {};
  for (const spec of BROWSERSTACK_DEVICE_FEATURE_SPECS) {
    const value = flags?.[spec.field];
    if (spec.type === 'negated-boolean' || spec.type === 'capture-boolean') {
      if (value === true) assignBooleanField(fields, spec);
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) continue;
    assignStringField(fields, spec, value);
  }
  return fields;
}

function assignBooleanField(
  fields: BrowserStackDeviceFeatureFields,
  spec: BrowserStackDeviceFeatureSpec,
): void {
  if (spec.field === 'providerNoResignApp') {
    fields.providerNoResignApp = true;
    return;
  }
  if (spec.field === 'providerNetworkLogs') fields.providerNetworkLogs = true;
}

function assignStringField(
  fields: BrowserStackDeviceFeatureFields,
  spec: BrowserStackDeviceFeatureSpec,
  value: string,
): void {
  if (spec.field === 'providerDeviceOrientation') {
    fields.providerDeviceOrientation = requireProviderDeviceOrientation(spec, value);
    return;
  }
  if (spec.field === 'providerNoResignApp' || spec.field === 'providerNetworkLogs') return;
  fields[spec.field] = value;
}

function requireSupportedPlatform(
  spec: BrowserStackDeviceFeatureSpec,
  platform: CloudWebDriverPlatform,
): void {
  if (!spec.platform || spec.platform === platform) return;
  throw new AppError(
    'INVALID_ARGS',
    `${spec.flag} applies to ${spec.platform} sessions only, but the session platform is ${platform}.`,
    {
      hint: `Drop ${spec.flag} or connect with --platform ${spec.platform}.`,
      flag: spec.flag,
      capability: spec.capability,
      platform,
    },
  );
}

function requireCompatibleNetworkFields(fields: BrowserStackDeviceFeatureFields): void {
  if (!fields.providerNetworkProfile || !fields.providerCustomNetwork) return;
  throw new AppError(
    'INVALID_ARGS',
    'BrowserStack accepts either a named network profile or a custom network shape, not both.',
    {
      hint: 'Pass only one of --provider-network-profile or --provider-custom-network.',
      networkProfile: fields.providerNetworkProfile,
      customNetwork: fields.providerCustomNetwork,
    },
  );
}
