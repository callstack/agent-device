import { expect, beforeEach, test, vi } from 'vitest';

const executors = vi.hoisted(() => ({
  android: vi.fn(),
  harmonyos: vi.fn(),
}));

vi.mock('@agent-device/platform-android/mechanics', () => ({
  runAndroidAdb: executors.android,
}));

vi.mock('@agent-device/platform-harmonyos', () => ({
  runHarmonyHdc: executors.harmonyos,
}));

import { createAppStateRuntimeHost } from './platform-runtime-app-state-host.ts';

const android = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
};
const harmony = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'Harmony',
  kind: 'device' as const,
};

beforeEach(() => {
  executors.android.mockReset();
  executors.harmonyos.mockReset();
  executors.android.mockResolvedValue({
    stdout: 'mCurrentFocus=Window{1 u0 com.example.android/.MainActivity}',
  });
  executors.harmonyos.mockResolvedValue({
    stdout:
      'Mission ID #76  mission name #[#com.example.harmony:entry:MainAbility]\nstate #FOREGROUND',
  });
});

test('keeps only focused cancellable command bridges in the root host', async () => {
  const host = createAppStateRuntimeHost();
  const signal = new AbortController().signal;

  await expect(
    host.android.run(android, { args: ['shell', 'dumpsys', 'window'], allowFailure: true }, signal),
  ).resolves.toEqual({
    stdout: 'mCurrentFocus=Window{1 u0 com.example.android/.MainActivity}',
  });
  expect(executors.android).toHaveBeenCalledWith(
    android,
    ['shell', 'dumpsys', 'window'],
    expect.objectContaining({ allowFailure: true, signal }),
  );

  await expect(
    host.harmonyos.run(harmony, { args: ['shell', 'aa', 'dump', '-l'], timeoutMs: 15_000 }, signal),
  ).resolves.toEqual({
    stdout:
      'Mission ID #76  mission name #[#com.example.harmony:entry:MainAbility]\nstate #FOREGROUND',
  });
  expect(executors.harmonyos).toHaveBeenCalledWith(
    harmony,
    ['shell', 'aa', 'dump', '-l'],
    expect.objectContaining({ timeoutMs: 15_000, signal }),
  );
});

test('forwards an in-flight abort to the underlying Android executor', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  executors.android.mockImplementationOnce(
    async (_device, _args, options: { signal?: AbortSignal }) => {
      observedSignal = options.signal;
      await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    },
  );

  const pending = createAppStateRuntimeHost().android.run(
    android,
    { args: ['shell', 'dumpsys', 'window'], allowFailure: true },
    controller.signal,
  );
  await vi.waitFor(() => expect(executors.android).toHaveBeenCalledTimes(1));

  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(observedSignal).toBe(controller.signal);
});
