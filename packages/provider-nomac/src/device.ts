import type { DeviceLease } from '@agent-device/contracts/device';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

export const NOMAC_PROVIDER = 'nomac';

/**
 * NoMac picks the phone with `--device` (`iphone`, the default, `ipad` or `iphone-pro-max`, or the
 * model's name). Every model runs iOS 27, so `--provider-os-version` takes 27 or a 27.x version.
 * Every other cloud profile field is refused rather than silently dropped.
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
    providerNetworkLogs: 'refused',
    providerNetworkHosts: 'refused',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};

/** NoMac's names for its phones, each one Simulator model on iOS 27. */
export type NomacPhoneDevice = 'iphone' | 'ipad' | 'iphone-pro-max';

const DEVICE_NAMES: Record<NomacPhoneDevice, { model: string; osVersion: string }> = {
  iphone: { model: 'iPhone 17 Pro', osVersion: '27' },
  ipad: { model: 'iPad Pro 11-inch (M5)', osVersion: '27' },
  'iphone-pro-max': { model: 'iPhone 17 Pro Max', osVersion: '27' },
};

/** The Simulator model behind one of NoMac's phone names. */
export function nomacPhoneModel(phone: NomacPhoneDevice): string {
  return DEVICE_NAMES[phone].model;
}

/**
 * The phone a lease asks for, from its profile's device (NoMac's name for it or the model's), its OS
 * version, if given, 27 or 27.x.
 */
export function nomacPhoneDevice(
  flags: Readonly<Record<string, unknown>> | undefined,
): NomacPhoneDevice {
  const name = readString(flags?.device)?.toLowerCase() ?? 'iphone';
  const version = readString(flags?.providerOsVersion) ?? '27';
  const phone = (Object.keys(DEVICE_NAMES) as NomacPhoneDevice[]).find(
    (key) => key === name || DEVICE_NAMES[key].model.toLowerCase() === name,
  );
  if (!phone) {
    throw new AppError(
      'INVALID_ARGS',
      `NoMac has no "${name}"; use --device iphone (iPhone 17 Pro), ipad (iPad Pro 11-inch (M5)) or iphone-pro-max (iPhone 17 Pro Max).`,
    );
  }
  if (version.split('.')[0] !== '27') {
    throw new AppError(
      'INVALID_ARGS',
      `NoMac has no iOS ${version}; its phones run iOS 27, so leave --provider-os-version out or pass 27.`,
    );
  }
  return phone;
}

export function isNomacLeaseBackend(backend: string): boolean {
  return backend === 'ios-instance';
}

export function buildNomacDevice(lease: DeviceLease, phone: NomacPhoneDevice): DeviceInfo {
  const names = DEVICE_NAMES[phone];
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: nomacDeviceId(lease.leaseId),
    // `--device` selects a device by its name, and connect saves the model's name as the device.
    name: names.model,
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
