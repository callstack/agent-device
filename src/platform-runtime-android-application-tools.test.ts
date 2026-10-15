import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const runtimeHints = vi.hoisted(() => ({
  evaluated: false,
  clearRuntimeHintValues: vi.fn(async () => {}),
}));

vi.mock('./platform-runtime-runtime-hints.ts', () => {
  runtimeHints.evaluated = true;
  return { clearRuntimeHintValues: runtimeHints.clearRuntimeHintValues };
});

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  vi.resetModules();
  runtimeHints.evaluated = false;
  runtimeHints.clearRuntimeHintValues.mockClear();
});

async function createTools() {
  const { createAndroidApplicationTools } =
    await import('./platform-runtime-android-application-tools.ts');
  return createAndroidApplicationTools();
}

test('building the Android application tools does not load the runtime-hints operation', async () => {
  await createTools();

  expect(runtimeHints.evaluated).toBe(false);
  expect(runtimeHints.clearRuntimeHintValues).not.toHaveBeenCalled();
});

test('clearing runtime hints loads the runtime-hints operation and hands it the bound device and app', async () => {
  const tools = await createTools();

  await tools.clearRuntimeHints(device, {
    appId: 'com.example.app',
    values: { metroHost: '10.0.2.2', metroPort: '8081' },
  });

  expect(runtimeHints.evaluated).toBe(true);
  expect(runtimeHints.clearRuntimeHintValues).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      device,
      appId: 'com.example.app',
      values: { metroHost: '10.0.2.2', metroPort: '8081' },
    }),
  );
});
