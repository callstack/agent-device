import fs from 'node:fs';
import type { AgentDeviceBackend, BackendScreenshotOptions } from '@agent-device/contracts/backend';
import type { CommandClock, CommandSessionRecord } from '@agent-device/contracts/runtime-contract';
import { PNG } from '@agent-device/capture-kit/png';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { createLocalArtifactAdapter } from '../../../src/io.ts';
import { createCommandSurfaceAgentDevice } from '@agent-device/command-runtime';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';

type ContractBackendOverrides = Partial<
  Pick<
    AgentDeviceBackend,
    | 'captureSnapshot'
    | 'captureScreenshot'
    | 'tap'
    | 'tapTarget'
    | 'fill'
    | 'fillTarget'
    | 'performGesture'
    | 'resolveGestureViewport'
  >
> & {
  platform?: AgentDeviceBackend['platform'];
  /**
   * A scenario-owned clock, so a guarantee with a time budget (the moving-target window) can state
   * its timing claim without a wall-clock race. Without one the runtime falls back to real time.
   */
  clock?: CommandClock;
  /**
   * Session state beyond the stored snapshot — the #3471 moving-target baseline is the case that
   * needs it, because the gate's whole premise is a session that has just finished mutating.
   */
  sessionState?: Partial<Omit<CommandSessionRecord, 'name'>>;
};

/**
 * The plain runtime harness for contract scenarios on the paths that never
 * touch the runner: runtime-selector, runtime-ref, native-ref (backend
 * tapTarget/fillTarget present) and coordinate. Path forcing is natural:
 * selector/ref targets pick the runtime path, a `tapTarget`/`fillTarget`
 * backend picks the native-ref fast path, x/y picks the coordinate path.
 */
export function createContractDevice(
  snapshot: SnapshotState,
  overrides: ContractBackendOverrides = {},
): ReturnType<typeof createCommandSurfaceAgentDevice> {
  const device = createCommandSurfaceAgentDevice({
    backend: {
      platform: overrides.platform ?? 'ios',
      captureSnapshot: async (...args) =>
        overrides.captureSnapshot ? await overrides.captureSnapshot(...args) : { snapshot },
      captureScreenshot: overrides.captureScreenshot
        ? async (...args) => (await overrides.captureScreenshot?.(...args)) ?? {}
        : undefined,
      tap: async (...args) => await overrides.tap?.(...args),
      tapTarget: overrides.tapTarget,
      fill: async (...args) => await overrides.fill?.(...args),
      fillTarget: overrides.fillTarget,
      performGesture: overrides.performGesture,
      resolveGestureViewport: overrides.resolveGestureViewport,
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    policy: localCommandPolicy(),
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  // The default store writes in memory, so the session exists before the device is returned.
  if (device.sessions.set({ name: 'default', snapshot, ...overrides.sessionState }) !== undefined) {
    throw new Error('The default session store must write synchronously');
  }
  return device;
}

/**
 * A contract-scenario clock: `now()` reads elapsed virtual time and `sleep()` advances it. A
 * guarantee with a time budget — the #3471 moving-target window — can then assert what it waited
 * without racing the machine it runs on.
 */
export function createContractClock(startMs = 0): {
  now(): number;
  sleep(ms: number): Promise<void>;
} {
  let elapsed = startMs;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += Math.max(ms, 0);
    },
  };
}

export function ref(
  value: string,
  options: { fallbackLabel?: string } = {},
): import('@agent-device/contracts/interaction').RefTarget {
  return {
    kind: 'ref',
    ref: value,
    ...(options.fallbackLabel ? { fallbackLabel: options.fallbackLabel } : {}),
  };
}
export function selector(
  value: string,
): import('@agent-device/contracts/interaction').SelectorTarget {
  return { kind: 'selector', selector: value };
}

/**
 * The screenshot-diff evidence scenarios pair frames by capture order (before,
 * then after): the backend replays one solid-color PNG per planned frame and
 * repeats the last one if the runtime captures more. The recorded capture
 * options ride along for the scenario to assert on.
 */
export function screenshotFramePlanBackend(
  frames: ReadonlyArray<{
    color: readonly [number, number, number];
    width?: number;
    height?: number;
  }>,
): Pick<AgentDeviceBackend, 'captureScreenshot'> & { captured: BackendScreenshotOptions[] } {
  let frameIndex = 0;
  const captured: BackendScreenshotOptions[] = [];
  return {
    captured,
    captureScreenshot: async (_context, outPath, options) => {
      const frame = frames[Math.min(frameIndex, frames.length - 1)]!;
      frameIndex += 1;
      if (options) captured.push(options);
      const png = new PNG({ width: frame.width ?? 8, height: frame.height ?? 8 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = frame.color[0];
        png.data[i + 1] = frame.color[1];
        png.data[i + 2] = frame.color[2];
        png.data[i + 3] = 255;
      }
      fs.writeFileSync(outPath, PNG.sync.write(png));
      return { path: outPath };
    },
  };
}
