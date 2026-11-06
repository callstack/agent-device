import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuote } from '@agent-device/kernel/device-shell';
import type { SinglePointerGesturePlan } from '@agent-device/contracts/gesture-plan-types';
import { runHarmonyShell, type HarmonyHdcOptions } from './hdc.ts';

/**
 * The carrier HAP (`examples/harmony-trajectory-driver`) injects one want-parameterized
 * multi-point trajectory through the platform test API. This module renders the plan into the
 * carrier's request, drives `aa test`, and reads the outcome. The carrier name is a constant:
 * one focus, one bundle, nothing to configure.
 */
export const HARMONY_TRAJECTORY_DRIVER_BUNDLE = 'com.stringzhao.adtrajdriver';
const CARRIER_MODULE = 'entry_test';
const CARRIER_RUNNER = 'OpenHarmonyTestRunner';
const MIN_SPEED_PX_PER_S = 200;
const MAX_SPEED_PX_PER_S = 40000;
const INJECTION_TIMEOUT_PER_SAMPLE_MS = 60;
const INJECTION_TIMEOUT_MARGIN_MS = 20_000;

export type HarmonyTrajectoryRequest = Readonly<{
  steps: readonly { x: number; y: number }[];
  speed: number;
}>;

export type HarmonyTrajectoryOutcome = Readonly<{
  backend: 'harmonyos-uitest-inputpointer';
  accepted: boolean;
  sampleCount: number;
  speed: number;
  detail: string;
}>;

const driverBundleCache = new Map<string, boolean>();

/** Renders the lowered plan into the carrier's JSON request: steps plus the pacing speed. */
export function renderHarmonyTrajectoryRequest(
  plan: SinglePointerGesturePlan,
): HarmonyTrajectoryRequest {
  const samples = plan.pointers[0].samples;
  const steps = samples.map((sample) => ({
    x: Math.round(sample.point.x),
    y: Math.round(sample.point.y),
  }));
  let pathLengthPx = 0;
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1]!;
    const current = steps[index]!;
    pathLengthPx += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  const seconds = Math.max(1, plan.durationMs) / 1000;
  const speed = Math.min(
    Math.max(Math.round(pathLengthPx / seconds), MIN_SPEED_PX_PER_S),
    MAX_SPEED_PX_PER_S,
  );
  return { steps, speed };
}

export function renderHarmonyTrajectoryJson(request: HarmonyTrajectoryRequest): string {
  return JSON.stringify({ steps: request.steps, speed: request.speed });
}

/**
 * Whether the carrier HAP is installed. `bm dump -n` answers with the bundle metadata on success
 * and a nonzero stdout-less failure otherwise; hdc keeps both as stream content, so the check
 * reads the answer's shape instead of the exit code.
 */
export async function isHarmonyTrajectoryDriverInstalled(device: DeviceInfo): Promise<boolean> {
  const cached = driverBundleCache.get(device.id);
  if (cached !== undefined) return cached;
  const listing = await runHarmonyShell(
    device,
    ['bm', 'dump', '-n', HARMONY_TRAJECTORY_DRIVER_BUNDLE],
    {
      allowFailure: true,
    },
  );
  const installed = listing.stdout.includes(HARMONY_TRAJECTORY_DRIVER_BUNDLE);
  driverBundleCache.set(device.id, installed);
  return installed;
}

/**
 * Injects one trajectory through the carrier: `aa test` runs the single case, the case's hilog
 * line carries the injection verdict, and the runner's own output confirms the case result.
 */
export async function injectHarmonyTrajectoryViaDriver(
  device: DeviceInfo,
  plan: SinglePointerGesturePlan,
  options?: HarmonyHdcOptions,
): Promise<HarmonyTrajectoryOutcome> {
  const request = renderHarmonyTrajectoryRequest(plan);
  const trajJson = renderHarmonyTrajectoryJson(request);
  const timeoutMs =
    plan.durationMs +
    request.steps.length * INJECTION_TIMEOUT_PER_SAMPLE_MS +
    INJECTION_TIMEOUT_MARGIN_MS;
  const script = renderHarmonyDriverScript(trajJson, timeoutMs);
  const output = await runHarmonyShell(device, ['sh', '-c', script], {
    ...options,
    timeoutMs,
    allowFailure: true,
  });
  const carrierResult = parseCarrierResult(output.stdout);
  const accepted =
    carrierResult?.ok === true || /Tests run: 1, Failure: 0, Error: 0, Pass: 1/.test(output.stdout);
  const detail = carrierResult?.error ?? parseCarrierDetail(output.stdout) ?? 'carrier accepted';
  return {
    backend: 'harmonyos-uitest-inputpointer',
    accepted,
    sampleCount: request.steps.length,
    speed: request.speed,
    detail,
  };
}

/**
 * The device-side recipe, in one shell: the uitest daemon must be pre-started (commercial builds
 * never start it on their own, and `aa test` blocks without it), the case runs, and the carrier's
 * hilog verdict is read back in the same session.
 */
function renderHarmonyDriverScript(trajJson: string, timeoutMs: number): string {
  const quoted = shellQuote(trajJson);
  // Newline-joined, not `;`-joined: the backgrounded daemon line ends in `&`, and `&;` is a
  // syntax error.
  return [
    'uitest start-daemon adtraj &',
    'sleep 1.5',
    `aa test -b ${HARMONY_TRAJECTORY_DRIVER_BUNDLE} -m ${CARRIER_MODULE} -s unittest ${CARRIER_RUNNER} -s timeout ${Math.round(timeoutMs)} -s traj ${quoted}`,
    'sleep 1',
    'hilog -x | grep ADTRAJ_RESULT | tail -1',
  ].join('\n');
}

/** Parses the carrier's `ADTRAJ_RESULT {json}` hilog line out of the combined script output. */
function parseCarrierResult(scriptOutput: string): { ok: boolean; error: string } | undefined {
  const line = /ADTRAJ_RESULT (\{.*)/.exec(scriptOutput)?.[1];
  if (!line) return undefined;
  const end = line.indexOf('}');
  try {
    const parsed = JSON.parse(line.slice(0, end + 1)) as { ok: boolean; error: string };
    return { ok: parsed.ok === true, error: String(parsed.error ?? '') };
  } catch {
    return undefined;
  }
}

/**
 * The carrier case fails loudly when the injection refused, so the runner output carries the
 * assertion; the hilog detail (elapsed, sample count) is advisory and never blocks.
 */
export function parseCarrierDetail(runnerOutput: string): string | undefined {
  const failLine = /fail:\s*\[adtraj\]\s*injectTrajectory\s*(.+)/i.exec(runnerOutput)?.[1];
  if (failLine) return failLine.trim();
  const errorLine = /inject failed: ([^\r\n]+)/i.exec(runnerOutput)?.[1];
  if (errorLine) return errorLine.trim();
  return undefined;
}

/** Refusal for a plan whose carrier is missing: names the install step, not a vague gap. */
export function trajectoryDriverMissingError(): AppError {
  return new AppError(
    'UNSUPPORTED_OPERATION',
    `HarmonyOS trajectory injection needs the carrier HAP ${HARMONY_TRAJECTORY_DRIVER_BUNDLE}`,
    {
      reason: 'trajectory-driver-missing',
      hint: 'Build and install examples/harmony-trajectory-driver with a debug signature; the endpoint swipe transport stays available without it.',
    },
  );
}
