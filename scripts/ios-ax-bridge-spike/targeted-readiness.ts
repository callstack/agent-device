import { performance } from 'node:perf_hooks';
import { createGuestSimulatorFrameworkBridgeAdapter } from './guest-adapter.ts';
import {
  adapterOptions,
  missingResponse,
  targetedRequest,
  usableTree,
} from './targeted-request.ts';
import type { SpikeConfig } from './config.ts';
import type { ScreenId } from '../ios-snapshot-benchmark/types.ts';

const READINESS_POLL_MS = 200;
const READINESS_DEADLINE_MS = 90_000;
const READINESS_PROBE_REQUEST_MS = 60_000;

export async function awaitAppReadiness(
  config: SpikeConfig,
  appPid: number,
  screen: ScreenId,
  expectedAnchor?: string,
): Promise<{ readinessMs: number; attempts: number }> {
  const limits = { ...config.limits, maxDurationMs: READINESS_PROBE_REQUEST_MS };
  const probe = createGuestSimulatorFrameworkBridgeAdapter({
    ...adapterOptions(config),
    limits,
  });
  const started = performance.now();
  let attempts = 0;
  try {
    for (;;) {
      assertReadinessDeadline(started, appPid, screen);
      attempts += 1;
      if (await probeReady(config, probe, limits, appPid, screen, expectedAnchor, attempts)) {
        return { readinessMs: performance.now() - started, attempts };
      }
      await sleep(READINESS_POLL_MS);
    }
  } finally {
    await probe.close?.();
  }
}

async function probeReady(
  config: SpikeConfig,
  probe: ReturnType<typeof createGuestSimulatorFrameworkBridgeAdapter>,
  limits: SpikeConfig['limits'],
  appPid: number,
  screen: ScreenId,
  expectedAnchor: string | undefined,
  attempt: number,
): Promise<boolean> {
  const id = `readiness-${screen}-${appPid}-${attempt}`;
  const result = await probe.acquireBatch([
    targetedRequest(config, id, {
      state: 'relaunch',
      screen,
      expectedTargetGeneration: `pid:${appPid}`,
      limits,
    }),
  ]);
  return usableTree(result.responses[0] ?? missingResponse(id), `pid:${appPid}`, expectedAnchor);
}

function assertReadinessDeadline(started: number, appPid: number, screen: ScreenId): void {
  if (performance.now() - started < READINESS_DEADLINE_MS) return;
  throw new Error(`App generation pid:${appPid} did not expose ${screen} in time.`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
