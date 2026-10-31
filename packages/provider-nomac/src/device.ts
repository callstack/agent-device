import type { DeviceLease } from '@agent-device/contracts/device';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export const NOMAC_PROVIDER = 'nomac';

/**
 * NoMac picks the phone from two models with `--device` (`iphone`, the default, or `ipad`, or the
 * model's name). Both run iOS 27, so `--provider-os-version` takes only `27`. Every other cloud
 * profile field is refused rather than silently dropped.
 */
export const NOMAC_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: NOMAC_PROVIDER,
  label: 'NoMac',
  fields: {
    providerApp: 'refused',
    providerOsVersion: 'consumed',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'refused',
    providerSessionName: 'refused',
    providerDeviceOrientation: 'refused',
    providerGeoLocation: 'refused',
    providerTimezone: 'refused',
    providerAppiumVersion: 'refused',
    providerLanguage: 'refused',
    providerLocale: 'refused',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};

/** NoMac's names for its phones: `iphone` (iPhone 17 Pro, iOS 27) and `ipad` (iPad Pro 11-inch (M5), iOS 27). */
export type NomacPhoneDevice = 'iphone' | 'ipad';

/** The phone a lease asks for, from its profile's device (a name or `iphone`/`ipad`); its OS version, if given, must be 27. */
export function nomacPhoneDevice(
  flags: Readonly<Record<string, unknown>> | undefined,
): NomacPhoneDevice {
  const name = readString(flags?.device)?.toLowerCase() ?? 'iphone';
  const version = readString(flags?.providerOsVersion) ?? '27';
  const type = name.startsWith('ipad') ? 'ipad' : name.startsWith('iphone') ? 'iphone' : undefined;
  if (
    !type ||
    (name !== type && !Object.values(DEVICE_NAMES).some((d) => d.model.toLowerCase() === name))
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `NoMac has no "${name}"; use --device iphone (iPhone 17 Pro) or ipad (iPad Pro 11-inch (M5)).`,
    );
  }
  if (version.split('.')[0] !== '27') {
    throw new AppError(
      'INVALID_ARGS',
      `NoMac has no iOS ${version}; its phones run iOS 27 only, so leave --provider-os-version out or pass 27.`,
    );
  }
  return type;
}

const DEVICE_NAMES: Record<NomacPhoneDevice, { model: string; osVersion: string }> = {
  iphone: { model: 'iPhone 17 Pro', osVersion: '27' },
  ipad: { model: 'iPad Pro 11-inch (M5)', osVersion: '27' },
};

export function isNomacLeaseBackend(backend: string): boolean {
  return backend === 'ios-instance';
}

export function buildNomacDevice(
  lease: DeviceLease,
  phoneId: string,
  phone: NomacPhoneDevice,
): DeviceInfo {
  const names = DEVICE_NAMES[phone];
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: nomacDeviceId(lease.leaseId),
    name: `NoMac ${names.model} ${phoneId.replace(/^ses_/, '').slice(0, 8)}`,
    kind: 'simulator',
    target: 'mobile',
    model: names.model,
    osVersion: names.osVersion,
    booted: true,
  };
}

export function parseNomacDeviceId(value: string): { leaseId: string } | undefined {
  const [prefix, platform, ...rest] = value.split(':');
  const leaseId = rest.join(':');
  if (prefix !== NOMAC_PROVIDER || platform !== 'ios' || !leaseId) return undefined;
  return { leaseId };
}

/** The exact identities a NoMac runtime owns: the iOS simulators it built ids for. */
export function isSupportedNomacDevice(device: DeviceInfo): boolean {
  return (
    parseNomacDeviceId(device.id) !== undefined &&
    device.platform === 'apple' &&
    device.appleOs === 'ios' &&
    device.kind === 'simulator' &&
    device.target === 'mobile' &&
    device.iosPhysicalDeviceBackend === undefined
  );
}

function nomacDeviceId(leaseId: string): string {
  return `${NOMAC_PROVIDER}:ios:${leaseId}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
