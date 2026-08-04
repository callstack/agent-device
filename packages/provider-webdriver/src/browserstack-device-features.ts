import {
  PROVIDER_DEVICE_ORIENTATIONS,
  type CloudProviderProfileFields,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
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
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkProfile'
  | 'providerCustomNetwork'
  | 'providerNoResignApp'
>;

type BrowserStackDeviceFeatureSpec = {
  /** `CliFlags`/profile field this capability is configured from. */
  field: keyof BrowserStackDeviceFeatureFields;
  /** Key emitted inside `bstack:options`. */
  capability: string;
  /** Canonical CLI flag, so an error can name a recovery action. */
  flag: string;
  /**
   * `negated-boolean` is a flag whose presence means "turn the capability off" — BrowserStack
   * defaults `resignApp` to true, so the only useful instruction is the opt-out.
   */
  type: 'string' | 'enum' | 'negated-boolean';
  enumValues?: readonly string[];
  /** Platform the capability applies to; absent means both. */
  platform?: CloudWebDriverPlatform;
};

export const BROWSERSTACK_DEVICE_FEATURE_SPECS: readonly BrowserStackDeviceFeatureSpec[] = [
  {
    field: 'providerDeviceOrientation',
    capability: 'deviceOrientation',
    flag: '--provider-device-orientation',
    type: 'enum',
    enumValues: PROVIDER_DEVICE_ORIENTATIONS,
  },
  {
    field: 'providerGeoLocation',
    capability: 'geoLocation',
    flag: '--provider-geo-location',
    type: 'string',
  },
  {
    field: 'providerTimezone',
    capability: 'timezone',
    flag: '--provider-timezone',
    type: 'string',
  },
  {
    field: 'providerLanguage',
    capability: 'language',
    flag: '--provider-language',
    type: 'string',
  },
  {
    field: 'providerLocale',
    capability: 'locale',
    flag: '--provider-locale',
    type: 'string',
  },
  {
    field: 'providerNetworkProfile',
    capability: 'networkProfile',
    flag: '--provider-network-profile',
    type: 'string',
  },
  {
    field: 'providerCustomNetwork',
    capability: 'customNetwork',
    flag: '--provider-custom-network',
    type: 'string',
  },
  {
    // BrowserStack re-signs uploaded iOS apps with its own provisioning profile, which strips
    // entitlements. Opting out keeps entitlement-dependent features (push notifications) testable.
    field: 'providerNoResignApp',
    capability: 'resignApp',
    flag: '--provider-no-resign-app',
    type: 'negated-boolean',
    platform: 'ios',
  },
];

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
    capabilities[spec.capability] = spec.type === 'negated-boolean' ? false : value;
  }
  return capabilities;
}

/**
 * Canonical CLI flags for every device-feature capability set on `flags`.
 *
 * These capabilities are BrowserStack-owned. Other providers have no equivalent, so a caller who
 * passes them to AWS Device Farm would otherwise have them accepted, persisted into the profile,
 * and then silently dropped — the session runs with provider defaults and nothing says why.
 * Callers use this to reject them at the point the provider is known.
 */
function browserStackOnlyDeviceFeatureFlags(flags: Record<string, unknown> | undefined): string[] {
  return BROWSERSTACK_DEVICE_FEATURE_SPECS.filter((spec) => {
    const value = flags?.[spec.field];
    return value !== undefined && value !== false && value !== '';
  }).map((spec) => spec.flag);
}

/**
 * Fails when a non-BrowserStack provider was given BrowserStack-owned device features.
 *
 * Called from both the CLI profile builder and the provider's own session preparation. The second
 * is the one that actually closes the hole: the typed client and hand-authored remote-config
 * profiles reach session preparation without passing through `connect`, so a CLI-only check leaves
 * those routes accepting the capabilities and dropping them.
 */
export function rejectBrowserStackOnlyDeviceFeatures(
  flags: Record<string, unknown> | undefined,
  provider: string,
): void {
  const configured = browserStackOnlyDeviceFeatureFlags(flags);
  if (configured.length === 0) return;
  const plural = configured.length !== 1;
  throw new AppError(
    'INVALID_ARGS',
    `${configured.join(', ')} ${plural ? 'are' : 'is'} only supported by BrowserStack, not ${provider}.`,
    {
      hint: `Drop ${plural ? 'those flags' : 'the flag'} or use the browserstack provider.`,
      provider,
      flags: configured,
    },
  );
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
    if (spec.type === 'negated-boolean') {
      if (value === true) fields.providerNoResignApp = true;
      continue;
    }
    if (typeof value !== 'string' || value.length === 0) continue;
    assignStringField(fields, spec, value);
  }
  return fields;
}

function assignStringField(
  fields: BrowserStackDeviceFeatureFields,
  spec: BrowserStackDeviceFeatureSpec,
  value: string,
): void {
  if (spec.field === 'providerDeviceOrientation') {
    fields.providerDeviceOrientation = requireDeviceOrientation(spec, value);
    return;
  }
  if (spec.field === 'providerNoResignApp') return;
  fields[spec.field] = value;
}

function requireDeviceOrientation(
  spec: BrowserStackDeviceFeatureSpec,
  value: string,
): (typeof PROVIDER_DEVICE_ORIENTATIONS)[number] {
  const match = PROVIDER_DEVICE_ORIENTATIONS.find((orientation) => orientation === value);
  if (match) return match;
  throw new AppError('INVALID_ARGS', `Invalid ${spec.flag} value: ${value}.`, {
    hint: `Use ${PROVIDER_DEVICE_ORIENTATIONS.join('|')}.`,
    flag: spec.flag,
    capability: spec.capability,
  });
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
