import { beforeEach, expect, test, vi } from 'vitest';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';

// #3377 review: `--maestro` selects a backend, but the format resolver only routes a source to it
// for a flow file. A suite whose sources are all `.ad` must keep the pre-registry lazy-loading
// property (#1802) — the discovery builder may not resolve (or evaluate) the backend for it.
vi.mock('../replay-backend-registry.ts', () => ({
  getReplayBackend: vi.fn(async () => ({
    inspectSource: () => ({ title: undefined, appTarget: undefined }),
  })),
}));

const { getReplayBackend } = await import('../replay-backend-registry.ts');
const { buildReplayTestSourceDiscovery } = await import('../session-test-source-discovery.ts');

function bundleFor(path: string): ReplayScriptSourceBundle {
  return { entry: path, files: { [path]: '' } };
}

beforeEach(() => {
  vi.mocked(getReplayBackend).mockClear();
});

test('--maestro over an all-.ad suite does not resolve a backend', async () => {
  await buildReplayTestSourceDiscovery(
    [bundleFor('/suite/a.ad'), bundleFor('/suite/b.ad')],
    'maestro',
  );
  expect(getReplayBackend).not.toHaveBeenCalled();
});

test('a flow source in the suite resolves the backend once for the whole run', async () => {
  const discover = await buildReplayTestSourceDiscovery(
    [bundleFor('/suite/a.ad'), bundleFor('/suite/flow.yaml'), bundleFor('/suite/c.yaml')],
    'maestro',
  );
  expect(getReplayBackend).toHaveBeenCalledTimes(1);
  expect(discover().map((source) => source.manifest.device.platform.kind)).toEqual([
    'unspecified',
    'caller-bound',
    'caller-bound',
  ]);
});

test('without a backend flag, discovery never resolves one', async () => {
  await buildReplayTestSourceDiscovery([bundleFor('/suite/flow.yaml')], undefined);
  expect(getReplayBackend).not.toHaveBeenCalled();
});
