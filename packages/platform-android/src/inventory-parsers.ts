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

/** The properties discovery reads for a running device, in the order its probe prints them. */
export const ANDROID_INVENTORY_PROPS = [
  'sys.boot_completed',
  'ro.boot.qemu.avd_name',
  'persist.sys.avd_name',
  'ro.product.model',
  'ro.build.version.release',
  'ro.build.characteristics',
] as const;

export type AndroidDeviceProps = Readonly<
  Partial<Record<(typeof ANDROID_INVENTORY_PROPS)[number], string>>
>;

/** One line per property in ANDROID_INVENTORY_PROPS order; `getprop` prints an unset one as empty. */
export function parseAndroidDeviceProps(rawOutput: string): AndroidDeviceProps {
  const lines = rawOutput.split(/\r?\n/);
  return Object.fromEntries(
    ANDROID_INVENTORY_PROPS.flatMap((prop, index) => {
      const value = lines[index]?.trim();
      return value ? [[prop, value]] : [];
    }),
  );
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
