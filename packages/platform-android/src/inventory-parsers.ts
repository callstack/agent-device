import { normalizeAndroidDeviceName } from '@agent-device/contracts/device';

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

export function parseAndroidAvdList(rawOutput: string): string[] {
  return rawOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

export function parseAndroidFeatureListForTv(rawOutput: string): boolean {
  return /feature:android\.(software\.leanback(_only)?|hardware\.type\.television)\b/i.test(
    rawOutput,
  );
}

export function inferAndroidAvdTarget(avdName: string): 'mobile' | 'tv' {
  return /\b(tv|television)\b/i.test(normalizeAndroidDeviceName(avdName)) ? 'tv' : 'mobile';
}
