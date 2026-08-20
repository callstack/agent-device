import { expect, test, vi } from 'vitest';
import type { ElementSelectorKey } from '@agent-device/contracts/interaction';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import { bindAppleFindSelectorRuntime } from './runtime-snapshot.ts';

const ios = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios',
  name: 'iOS',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const satisfies DeviceInfo;

test('findSelector resolves the owner interactor once with request execution and cancellation', async () => {
  const findSelector = vi.fn(
    async (
      _selector: Readonly<{ key: ElementSelectorKey; value: string }>,
      _options?: { appBundleId?: string; signal?: AbortSignal },
    ) => ({ found: true }),
  );
  const resolve = vi.fn(async () => ({ findSelector }) as never);
  const host = { ...platformRuntimeHostFixture(), localInteractors: { resolve } };
  const request = new AbortController();
  const poll = new AbortController();
  const operation = bindAppleFindSelectorRuntime(host, { device: ios, signal: request.signal });

  await expect(
    operation.findSelector({
      selector: { key: 'id', value: 'submit' },
      options: { appBundleId: 'com.example.app', surface: 'app' },
      execution: { requestId: 'request-1' },
      signal: poll.signal,
    }),
  ).resolves.toEqual({ found: true });

  expect(resolve).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith(
    ios,
    expect.objectContaining({ appBundleId: 'com.example.app', requestId: 'request-1' }),
  );
  expect(findSelector).toHaveBeenCalledWith(
    { key: 'id', value: 'submit' },
    expect.objectContaining({ appBundleId: 'com.example.app', signal: expect.any(AbortSignal) }),
  );
  const signal = findSelector.mock.calls[0]?.[1]?.signal;
  poll.abort(new DOMException('poll ended', 'AbortError'));
  expect(signal?.aborted).toBe(true);
});

test.each([
  ['no active app', ios, undefined, undefined],
  [
    'non-app macOS surface',
    { ...ios, appleOs: 'macos', kind: 'device', target: 'desktop' } as const,
    'com.example.app',
    'desktop' as const,
  ],
])(
  'findSelector declines %s without resolving an interactor',
  async (_name, device, appBundleId, surface) => {
    const resolve = vi.fn(async () => ({}) as never);
    const host = { ...platformRuntimeHostFixture(), localInteractors: { resolve } };
    const operation = bindAppleFindSelectorRuntime(host, {
      device,
      signal: new AbortController().signal,
    });

    await expect(
      operation.findSelector({
        selector: { key: 'label', value: 'Settings' },
        options: { ...(appBundleId ? { appBundleId } : {}), ...(surface ? { surface } : {}) },
      }),
    ).resolves.toEqual({ found: false });
    expect(resolve).not.toHaveBeenCalled();
  },
);
