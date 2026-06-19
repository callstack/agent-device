import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createWebInteractor } from '../interactors/web.ts';
import { AppError } from '../../utils/errors.ts';
import { withWebProvider, type WebProvider } from '../../platforms/web/provider.ts';

test('web interactor delegates first-slice operations to the scoped provider', async () => {
  const calls: string[] = [];
  const interactor = createWebInteractor();
  const provider = makeWebProvider({
    async open(target, options) {
      calls.push(`open:${target}:${options?.url ?? ''}`);
    },
    async close(target) {
      calls.push(`close:${target ?? ''}`);
    },
    async snapshot(options) {
      calls.push(`snapshot:${options?.scope ?? ''}`);
      return {
        nodes: [{ index: 0, role: 'button', label: 'Submit' }],
        truncated: true,
      };
    },
    async screenshot(outPath, options) {
      calls.push(`screenshot:${outPath}:${options?.fullscreen === true}`);
    },
    async click(x, y) {
      calls.push(`click:${x}:${y}`);
    },
    async fill(x, y, text, options) {
      calls.push(`fill:${x}:${y}:${text}:${options?.delayMs ?? 0}`);
    },
    async typeText(text, options) {
      calls.push(`type:${text}:${options?.delayMs ?? 0}`);
    },
    async scroll(direction, options) {
      calls.push(`scroll:${direction}:${options?.pixels ?? options?.amount ?? ''}`);
    },
  });

  const snapshot = await withWebProvider(provider, async () => {
    await interactor.open('https://example.test');
    await interactor.open('app-shell', { url: 'https://example.test/deep' });
    await interactor.close('app-shell');
    await interactor.tap(10, 20);
    await interactor.focus(11, 21);
    await interactor.fill(12, 22, 'hello', 5);
    await interactor.type('world', 6);
    await interactor.scroll('down', { pixels: 400 });
    await interactor.screenshot('/tmp/web.png', { fullscreen: true });
    return await interactor.snapshot({ scope: 'main' });
  });

  assert.deepEqual(calls, [
    'open:https://example.test:',
    'open:https://example.test/deep:https://example.test/deep',
    'close:app-shell',
    'click:10:20',
    'click:11:21',
    'fill:12:22:hello:5',
    'type:world:6',
    'scroll:down:400',
    'screenshot:/tmp/web.png:true',
    'snapshot:main',
  ]);
  assert.equal(snapshot.backend, 'web');
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(snapshot.nodes, [{ index: 0, role: 'button', label: 'Submit' }]);
});

test('web interactor reports unsupported operations explicitly', async () => {
  const interactor = createWebInteractor();

  await assert.rejects(
    () => interactor.back(),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.message === 'back is not supported on web',
  );
});

function makeWebProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}
