import type { RunnerWarmLossNotice } from '@agent-device/platform-apple/runner/operations';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';

export type { RunnerWarmLossNotice };

/**
 * Takes the warm-runner loss notice recorded for this device by the Apple runner's destination
 * watcher, once, if there is one (#3321). A notice exists only when a runner retained after
 * `close` was stopped because its connection closed, typically because something shut the Simulator
 * down under it — the state the next `open` reports rather than leaves the caller to infer from a
 * cold start. Families that retain no warm runner record no notice.
 *
 * The notice is read through the platform's public operations surface from this root module: the
 * daemon must not import a concrete platform package (R65), and the notice is a runner fact, not a
 * session fact — it exists precisely in the gap where no session is live.
 */
export async function takeWarmRunnerLossNotice(
  device: DeviceInfo,
): Promise<RunnerWarmLossNotice | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  const { takeRunnerWarmLossNotice } =
    await import('@agent-device/platform-apple/runner/operations');
  return takeRunnerWarmLossNotice(device.id);
}
