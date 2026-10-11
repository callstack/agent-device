import { beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';

const { queryAppleRunnerSelector } = vi.hoisted(() => ({
  queryAppleRunnerSelector: vi.fn(async (): Promise<Record<string, unknown>> => ({
    found: true,
  })),
}));

vi.mock('../core/runner-selector-query.ts', () => ({ queryAppleRunnerSelector }));

import { bindAppleQuerySelectorRuntime } from '../runtime-selector-query.ts';

beforeEach(() => {
  queryAppleRunnerSelector.mockReset();
  queryAppleRunnerSelector.mockResolvedValue({ found: true });
});

const APP = 'com.example.app';

function bind(signal?: AbortSignal) {
  return bindAppleQuerySelectorRuntime({
    device: IOS_SIMULATOR,
    signal: signal ?? new AbortController().signal,
  });
}

test('forwards the selector, app scope, and the full runner-execution projection', async () => {
  await bind().querySelector({
    selector: { key: 'id', value: 'submit-order' },
    options: { appBundleId: APP },
    execution: {
      requestId: 'req-9',
      logPath: '/tmp/runner.log',
      traceLogPath: '/tmp/trace.log',
      verbose: true,
      iosXctestrunFile: '/tmp/run.xctestrun',
    },
  });

  expect(queryAppleRunnerSelector).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    { key: 'id', value: 'submit-order' },
    APP,
    expect.objectContaining({
      requestId: 'req-9',
      logPath: '/tmp/runner.log',
      traceLogPath: '/tmp/trace.log',
      verbose: true,
      iosXctestrunFile: '/tmp/run.xctestrun',
    }),
  );
});

test('refuses an already-aborted binding signal without querying the runner', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    bind(controller.signal).querySelector({ selector: { key: 'label', value: 'Go' } }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(queryAppleRunnerSelector).not.toHaveBeenCalled();
});

test('projects the matched node to its rect and hittability', async () => {
  queryAppleRunnerSelector.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true }],
  });

  await expect(bind().querySelector({ selector: { key: 'label', value: 'Go' } })).resolves.toEqual({
    found: true,
    node: { rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true },
  });
});

test('a miss answers found:false with no node', async () => {
  queryAppleRunnerSelector.mockResolvedValue({ found: false, nodes: [] });

  await expect(
    bind().querySelector({ selector: { key: 'label', value: 'Gone' } }),
  ).resolves.toEqual({ found: false });
});

test('a node without a usable rect answers found without a node (the rescue stays fail-closed)', async () => {
  queryAppleRunnerSelector.mockResolvedValue({ found: true, nodes: [{ index: 0 }] });

  await expect(bind().querySelector({ selector: { key: 'label', value: 'Go' } })).resolves.toEqual({
    found: true,
  });
});
