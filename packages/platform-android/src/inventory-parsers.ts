const ANDROID_EMULATOR_SERIAL_PREFIX = 'emulator-';

export function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith(ANDROID_EMULATOR_SERIAL_PREFIX);
}

export function normalizeAndroidDeviceName(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ').replaceAll(/\s+/g, ' ').trim();
}

export type AndroidDeviceEntry = Readonly<{
  serial: string;
  rawModel: string;
}>;

/** One listed row of `adb devices` output in any state (device, offline, unauthorized, ...). */
export type AndroidListedDeviceEntry = Readonly<{
  serial: string;
  state: string;
}>;

/**
 * Every serial `adb devices` (or `adb devices -l`) listed, with its state. The listing keeps
 * offline and unauthorized serials, which a caller proving host-wide device counts must see.
 */
export function parseAndroidListedDeviceEntries(rawOutput: string): AndroidListedDeviceEntry[] {
  const devices: AndroidListedDeviceEntry[] = [];
  for (const rawLine of rawOutput.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    const serial = parts[0];
    const state = parts[1];
    if (!serial || !state || serial === 'List' || serial.startsWith('*')) continue;
    devices.push({ serial, state });
  }
  return devices;
}

export function parseAndroidDeviceEntries(rawOutput: string): AndroidDeviceEntry[] {
  const devices: AndroidDeviceEntry[] = [];
  for (const rawLine of rawOutput.split('\n')) {
    const parts = rawLine.trim().split(/\s+/);
    const serial = parts[0];
    if (!serial || serial === 'List' || parts[1] !== 'device') continue;
    devices.push({
      serial,
      rawModel: (parts.find((entry) => entry.startsWith('model:')) ?? '').replace('model:', ''),
    });
  }
  return devices;
}

/** Reads the model and OS version lines printed by the inventory description probe, in order. */
export function parseAndroidDeviceDescription(rawOutput: string): {
  model?: string;
  osVersion?: string;
} {
  const [model, osVersion] = rawOutput.split(/\r?\n/).map((line) => line.trim());
  return {
    ...(model ? { model } : {}),
    ...(osVersion ? { osVersion } : {}),
  };
}

/** avdmanager restricts AVD names to these characters; other stdout lines are emulator logging. */
const ANDROID_AVD_NAME = /^[A-Za-z0-9._-]+$/;

export function parseAndroidAvdList(rawOutput: string): string[] {
  return rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => ANDROID_AVD_NAME.test(line));
}

export function parseAndroidEmulatorAvdNameOutput(rawOutput: string): string | undefined {
  const lines = rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.at(-1) === 'OK') lines.pop();
  return lines.join('\n').trim() || undefined;
}

export function parseAndroidTargetFromCharacteristics(rawOutput: string): 'tv' | null {
  const normalized = rawOutput.toLowerCase();
  return normalized.includes('tv') || normalized.includes('leanback') ? 'tv' : null;
}

/** `pm list features` prints one `feature:<name>` or `feature:<name>=<version>` line per feature. */
export function androidFeatureListDeclares(rawOutput: string, feature: string): boolean {
  const declared = `feature:${feature}`.toLowerCase();
  return rawOutput
    .split(/\r?\n/)
    .some((line) => line.trim().split('=')[0]?.toLowerCase() === declared);
}

export function inferAndroidAvdTarget(avdName: string): 'mobile' | 'tv' {
  return /\b(tv|television)\b/i.test(normalizeAndroidDeviceName(avdName)) ? 'tv' : 'mobile';
}
