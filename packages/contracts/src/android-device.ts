const ANDROID_EMULATOR_SERIAL_PREFIX = 'emulator-';

export function isAndroidEmulatorSerial(serial: string): boolean {
  return serial.startsWith(ANDROID_EMULATOR_SERIAL_PREFIX);
}

export function normalizeAndroidDeviceName(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
