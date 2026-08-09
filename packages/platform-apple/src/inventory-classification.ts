import type { AppleOS, DeviceInfo, DeviceTarget } from '@agent-device/kernel/device';

const APPLE_PRODUCT_TYPE_PATTERN = /^(iphone|ipad|ipod|appletv|realitydevice)/i;
const APPLE_IPAD_PATTERN = /ipad/i;
const APPLE_VISION_PATTERN = /\b(apple vision|vision pro|xros|visionos|realitydevice)\b/i;
const APPLE_MOBILE_LABEL_PATTERN = /\b(iphone|ipad|ipod)\b/i;
const APPLE_TV_PRODUCT_TYPE_PATTERN = /^appletv/i;
const APPLE_TV_LABEL_HINTS = ['apple tv', 'appletv', 'tvos'] as const;

export type DevicectlAppleDevice = {
  identifier?: string;
  name?: string;
  hardwareProperties?: { platform?: string; udid?: string; productType?: string };
  deviceProperties?: { name?: string; productType?: string; deviceType?: string };
  connectionProperties?: { tunnelState?: string };
};

function normalizeAppleDescriptor(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isAppleTvPlatform(platform: string): boolean {
  return platform.includes('tvos');
}

function isAppleVisionPlatform(platform: string): boolean {
  return platform.includes('xros') || platform.includes('visionos');
}

export function resolveAppleTargetFromRuntime(runtime: string): DeviceTarget {
  return isAppleTvPlatform(normalizeAppleDescriptor(runtime)) ? 'tv' : 'mobile';
}

export function isSupportedAppleRuntime(runtime: string): boolean {
  const normalized = normalizeAppleDescriptor(runtime);
  return (
    normalized.includes('ios') ||
    normalized.includes('tvos') ||
    normalized.includes('xros') ||
    normalized.includes('visionos')
  );
}

function isAppleTvLabel(value: string): boolean {
  const normalized = normalizeAppleDescriptor(value);
  return APPLE_TV_LABEL_HINTS.some((hint) => normalized.includes(hint));
}

function isAppleMobileLabel(value: string): boolean {
  return APPLE_MOBILE_LABEL_PATTERN.test(value.trim());
}

export function resolveAppleTargetFromLabel(value: string): DeviceTarget | null {
  if (isAppleTvLabel(value)) return 'tv';
  if (isAppleMobileLabel(value) || APPLE_VISION_PATTERN.test(value)) return 'mobile';
  return null;
}

export function resolveAppleOs(target: DeviceTarget, descriptors: string[]): AppleOS {
  if (target === 'tv') return 'tvos';
  if (descriptors.some((descriptor) => APPLE_VISION_PATTERN.test(descriptor))) return 'visionos';
  if (descriptors.some((descriptor) => APPLE_IPAD_PATTERN.test(descriptor))) return 'ipados';
  return 'ios';
}

export function isAppleProductType(productType: string): boolean {
  return APPLE_PRODUCT_TYPE_PATTERN.test(productType.trim());
}

function isAppleTvProductType(productType: string): boolean {
  return APPLE_TV_PRODUCT_TYPE_PATTERN.test(productType.trim());
}

function devicectlLabels(device: DevicectlAppleDevice): string[] {
  return [
    device.name ?? '',
    device.deviceProperties?.name ?? '',
    device.deviceProperties?.deviceType ?? '',
  ];
}

function devicectlProductType(device: DevicectlAppleDevice): string {
  return device.hardwareProperties?.productType ?? device.deviceProperties?.productType ?? '';
}

export function resolveAppleTargetFromDevicectlDevice(device: DevicectlAppleDevice): DeviceTarget {
  const platform = normalizeAppleDescriptor(device.hardwareProperties?.platform);
  if (isAppleTvPlatform(platform)) return 'tv';
  const productType = devicectlProductType(device);
  if (isAppleTvProductType(productType)) return 'tv';
  return devicectlLabels(device).some(isAppleTvLabel) ? 'tv' : 'mobile';
}

export function isSupportedAppleDevicectlDevice(device: DevicectlAppleDevice): boolean {
  const platform = normalizeAppleDescriptor(device.hardwareProperties?.platform);
  if (platform.includes('ios') || isAppleTvPlatform(platform) || isAppleVisionPlatform(platform)) {
    return true;
  }
  if (isAppleProductType(devicectlProductType(device))) return true;
  return devicectlLabels(device).some(isAppleTvLabel);
}

export function mapDevicectlAppleDevice(device: DevicectlAppleDevice): DeviceInfo | null {
  if (!isSupportedAppleDevicectlDevice(device)) return null;
  const id = device.hardwareProperties?.udid ?? device.identifier ?? '';
  const name = device.name ?? device.deviceProperties?.name ?? id;
  if (!id) return null;
  const target = resolveAppleTargetFromDevicectlDevice(device);
  return {
    platform: 'apple',
    id,
    name,
    kind: 'device',
    target,
    appleOs: resolveAppleOs(target, [devicectlProductType(device), ...devicectlLabels(device)]),
    iosPhysicalDeviceBackend: 'coredevice',
    booted: true,
  };
}
