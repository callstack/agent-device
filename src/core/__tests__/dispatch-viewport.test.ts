import { expect, test, vi } from 'vitest';
import { dispatchCommand } from '../dispatch.ts';
import { withWebProvider, type WebProvider } from '../../platforms/web/provider.ts';

const webDevice = {
  id: 'web',
  name: 'Web',
  platform: 'web',
  kind: 'device',
  booted: true,
} as const;

test('legacy dispatch no longer reaches the web interactor viewport operation', async () => {
  const setViewport = vi.fn(async () => undefined);
  const provider = makeWebProvider({ setViewport });

  await expect(
    withWebProvider(
      provider,
      async () => await dispatchCommand(webDevice, 'viewport', ['1280', '900']),
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'Unknown command: viewport',
  });

  expect(setViewport).not.toHaveBeenCalled();
});

function makeWebProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}
