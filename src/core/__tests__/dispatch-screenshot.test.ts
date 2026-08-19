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

test('legacy dispatch no longer reaches an interactor screenshot operation', async () => {
  const screenshot = vi.fn(async () => undefined);

  await expect(
    withWebProvider(
      makeWebProvider({ screenshot }),
      async () => await dispatchCommand(webDevice, 'screenshot', ['/tmp/out.png']),
    ),
  ).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    message: 'Unknown command: screenshot',
  });

  expect(screenshot).not.toHaveBeenCalled();
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
