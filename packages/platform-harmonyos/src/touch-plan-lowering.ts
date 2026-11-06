import { AppError } from '@agent-device/kernel/errors';
import { shellQuote } from '@agent-device/kernel/device-shell';
import {
  interpolateGesturePoint,
  sampleGestureOffsets,
} from '@agent-device/contracts/gesture-plan';
import type {
  PointerTrajectorySample,
  SinglePointerGesturePlan,
} from '@agent-device/contracts/gesture-plan-types';

/**
 * One `uinput sendevent` process per event bounds the affordable report count. A denser timed
 * path keeps its shape by even subsampling: endpoints and the pacing survive, the per-report
 * cadence stretches to fill the same wall clock.
 */
export const HARMONY_TOUCH_TRANSPORT_MAX_SAMPLES = 32;

/**
 * Bounds one `uinput sendevent` process spawn in the injection timeout budget. Calibrated
 * against device evidence, not assumed; the spawn cost is device-specific.
 */
export const SEND_EVENT_TIMEOUT_PER_SAMPLE_MS = 120;

/** Wall-clock headroom on top of duration and per-sample spawn budget for the whole script. */
export const TRAJECTORY_TIMEOUT_MARGIN_MS = 1_500;

/**
 * The script prints this marker only after every sendevent in the chain exited zero. The HDC
 * client never propagates a remote exit code (a failing remote command exits 0 on the host), so
 * the marker is the only closed-success observable the transport has.
 */
export const TRAJECTORY_INJECTION_SENTINEL = 'AGENT_DEVICE_TRAJECTORY_INJECTED';

/**
 * linux/input.h event vocabulary the injected touchscreen stream uses. The stream is written to
 * the panel's own evdev node, so the sequence must match the multi-touch Type-B protocol the
 * kernel driver already speaks: one claimed slot and tracking id, positions per report, and a
 * SYN_REPORT frame per sample.
 */
const EV_KEY = 0x01;
const EV_SYN = 0x00;
const EV_ABS = 0x03;
const SYN_REPORT = 0;
const ABS_MT_SLOT = 0x2f;
const ABS_MT_TRACKING_ID = 0x39;
const ABS_MT_POSITION_X = 0x35;
const ABS_MT_POSITION_Y = 0x36;
const BTN_TOUCH = 0x14a;
const INJECTED_TRACKING_ID = 7;
const INJECTED_MT_SLOT = 0;

export type HarmonyTouchEvent = Readonly<{
  type: number;
  code: number;
  value: number;
}>;

export type HarmonyTouchSample = Readonly<{
  /** Wall-clock pause the transport waits before this sample's events. */
  delayMs: number;
  events: readonly HarmonyTouchEvent[];
}>;

export type LoweredHarmonyTouchTrajectory = Readonly<{
  transport: 'harmonyos-sendevent';
  sampleCount: number;
  durationMs: number;
  samples: readonly HarmonyTouchSample[];
}>;

/** The touch panel's own coordinate space, read from the MMI device axis dump. */
export type TouchPanelRange = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}>;

export type HarmonyPanelTransform = Readonly<{
  displayWidth: number;
  displayHeight: number;
  range: TouchPanelRange;
}>;

/**
 * Why the sendevent transport is unavailable for a pan. The command falls back to the uiInput
 * endpoint swipe and reports the reason in its result instead of refusing, so behavior on
 * locked-down builds matches the pre-trajectory transport exactly.
 */
export type HarmonyPanTransportRefusalReason =
  | 'touch-node-listing-unreadable'
  | 'touch-node-not-found'
  | 'touch-panel-range-absent'
  | 'touch-panel-range-ambiguous'
  | 'render-resolution-unreadable'
  | 'display-rotation-unsupported';

export type HarmonyTouchScriptOptions = Readonly<{
  /** The touchscreen evdev node the sendevent calls write to. */
  deviceNode: string;
  /**
   * One `uinput sendevent` process spawn costs a few milliseconds on device; the pacing sleep
   * per sample sheds that estimate so the rendered wall clock stays near the plan's timeline.
   * Calibrated on hardware (docs/evidence), not assumed.
   */
  sendEventSpawnOverheadMs?: number;
}>;

/**
 * Densifies the plan's own timed path for the sendevent transport: the canonical offsets and the
 * shared 16 ms sampling grid merge, every merged offset interpolates inside its canonical
 * segment, and the union subsamples back under the transport budget. Endpoints and duration are
 * the plan's; the interior is the same line the plan builder described, just delivered as real
 * contact reports a recognizer can time.
 */
export function lowerHarmonyTouchPlan(
  plan: SinglePointerGesturePlan,
  transform: HarmonyPanelTransform,
): LoweredHarmonyTouchTrajectory {
  if (plan.topology !== 'single') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'HarmonyOS HDC does not support multi-touch gestures',
    );
  }
  const canonical = plan.pointers[0].samples;
  if (canonical.length < 2) {
    throw new AppError('COMMAND_FAILED', 'HarmonyOS gesture plan has no pointer endpoints');
  }
  const samples = subsampleForTransport(
    densifyCanonicalSamples(canonical, plan.durationMs),
    HARMONY_TOUCH_TRANSPORT_MAX_SAMPLES,
  );
  const first = samples[0]!;
  const last = samples.at(-1)!;
  const previous = samples.at(-2)!;
  const batches: HarmonyTouchSample[] = [
    { delayMs: 0, events: touchDownEvents(toPanelPoint(first.point, transform)) },
  ];
  for (let index = 1; index < samples.length - 1; index += 1) {
    const sample = samples[index]!;
    const before = samples[index - 1]!;
    batches.push({
      delayMs: sampleDelayMs(before.offsetMs, sample.offsetMs),
      events: touchMoveEvents(toPanelPoint(sample.point, transform)),
    });
  }
  batches.push({
    delayMs: sampleDelayMs(previous.offsetMs, last.offsetMs),
    events: touchUpEvents(toPanelPoint(last.point, transform)),
  });
  return {
    transport: 'harmonyos-sendevent',
    sampleCount: batches.length,
    durationMs: plan.durationMs,
    samples: batches,
  };
}

/**
 * Renders the lowered batches into one `sh -c` script the hdc transport carries verbatim. Each
 * sample's pacing sleep runs BEFORE that sample's events (the delay is the pause before the
 * batch, not after it), the whole down-move-up chain joins with `&&` so one failed panel write
 * aborts the rest, and the chain ends on the success marker. A failed chain still releases the
 * contact through the final up frame so a mid-flight denial cannot leave the panel stuck down.
 */
export function renderHarmonyTouchScript(
  trajectory: LoweredHarmonyTouchTrajectory,
  options: HarmonyTouchScriptOptions,
): string {
  const node = shellQuote(options.deviceNode);
  const overheadMs = Math.max(0, Math.round(options.sendEventSpawnOverheadMs ?? 0));
  const chain: string[] = [];
  for (const sample of trajectory.samples) {
    const sleepSeconds = Math.max(0, sample.delayMs - overheadMs) / 1000;
    if (sleepSeconds > 0) {
      chain.push(`sleep ${sleepSeconds.toFixed(3)}`);
    }
    for (const event of sample.events) {
      chain.push(`uinput sendevent ${node} ${event.type} ${event.code} ${event.value}`);
    }
  }
  chain.push(`echo ${TRAJECTORY_INJECTION_SENTINEL}`);
  const release = trajectory.samples
    .at(-1)!
    .events.map((event) => `uinput sendevent ${node} ${event.type} ${event.code} ${event.value}`);
  return `( ${chain.join(' && ')} ) || ( ${release.join(' && ')} )`;
}

/** Total wall clock the injection script may take before the host transport gives up. */
export function harmonyTrajectoryTimeoutMs(trajectory: LoweredHarmonyTouchTrajectory): number {
  return (
    trajectory.durationMs +
    trajectory.sampleCount * SEND_EVENT_TIMEOUT_PER_SAMPLE_MS +
    TRAJECTORY_TIMEOUT_MARGIN_MS
  );
}

/**
 * The touchscreen evdev node for a `/proc/bus/input/devices` listing: the entry whose name names
 * a touch panel and whose handlers carry an event node. Fingerprint readers, key rows, and
 * stylus-adjacent names are not touch panels, even when their names mention touch.
 */
export function parseHarmonyTouchDeviceNode(devicesListing: string): string | undefined {
  const entries = devicesListing.split('\n\n');
  for (const entry of entries) {
    const name = /N: Name="([^"]+)"/.exec(entry)?.[1] ?? '';
    const handlers = /H: Handlers=([^\n]+)/.exec(entry)?.[1] ?? '';
    if (!/touch/i.test(name) || /finger|fingerprint|key|pen|gpio/i.test(name)) continue;
    const node = /event\d+/.exec(handlers)?.[0];
    if (node) return `/dev/input/${node}`;
  }
  return undefined;
}

/**
 * The touch panel axis range from `hidumper -s MultimodalInput -a '-d'`, the MMI service's own
 * device dump. The service reads the kernel absinfo for the shell, so the range stays readable
 * on builds where `/dev/input` and `/proc/bus/input/devices` are denied. Every device exposing
 * both position axes must agree on the range; disagreeing entries leave the panel ambiguous.
 */
export type HarmonyTouchPanelRangeResult =
  | { kind: 'range'; range: TouchPanelRange }
  | { kind: 'absent' }
  | { kind: 'ambiguous' };

export function parseHarmonyTouchPanelRange(mmiDump: string): HarmonyTouchPanelRangeResult {
  const ranges: TouchPanelRange[] = [];
  for (const block of mmiDump.split(/(?=deviceId:)/)) {
    const x = /axisType:POSITION_X \| minimum:(-?\d+) \| maximum:(-?\d+)/.exec(block);
    const y = /axisType:POSITION_Y \| minimum:(-?\d+) \| maximum:(-?\d+)/.exec(block);
    if (!x || !y) continue;
    ranges.push({
      minX: Number(x[1]),
      maxX: Number(x[2]),
      minY: Number(y[1]),
      maxY: Number(y[2]),
    });
  }
  if (ranges.length === 0) return { kind: 'absent' };
  const first = ranges[0]!;
  const agrees = ranges.every(
    (range) =>
      range.minX === first.minX &&
      range.maxX === first.maxX &&
      range.minY === first.minY &&
      range.maxY === first.maxY,
  );
  return agrees ? { kind: 'range', range: first } : { kind: 'ambiguous' };
}

/** The active display's render resolution from `hidumper -s RenderService -a screen`. */
export function parseHarmonyRenderResolution(
  renderDump: string,
): { width: number; height: number } | undefined {
  const match = /render resolution=(\d+)x(\d+)/.exec(renderDump);
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * The display-to-panel transform for a portrait display: plan coordinates span the render
 * resolution, the panel range spans its own axis space, and one linear scale joins them. A
 * rotated display needs axis transposition the transport has not verified on hardware, so every
 * non-portrait shape refuses the transform and the command keeps the uiInput endpoint swipe.
 */
export type HarmonyPanelTransformResult =
  | { kind: 'transform'; transform: HarmonyPanelTransform }
  | { kind: 'render-resolution-unreadable' }
  | { kind: 'display-rotation-unsupported' };

export function resolveHarmonyPanelTransform(
  range: TouchPanelRange,
  renderResolution: { width: number; height: number } | undefined,
  viewport: { width: number; height: number },
): HarmonyPanelTransformResult {
  if (
    !renderResolution ||
    renderResolution.width < 2 ||
    renderResolution.height < 2 ||
    range.maxX <= range.minX ||
    range.maxY <= range.minY
  ) {
    return { kind: 'render-resolution-unreadable' };
  }
  const portraitDisplay = renderResolution.height > renderResolution.width;
  const portraitViewport = viewport.width < viewport.height;
  if (!portraitDisplay || !portraitViewport) {
    return { kind: 'display-rotation-unsupported' };
  }
  return {
    kind: 'transform',
    transform: {
      displayWidth: renderResolution.width,
      displayHeight: renderResolution.height,
      range,
    },
  };
}

function densifyCanonicalSamples(
  canonical: readonly PointerTrajectorySample[],
  durationMs: number,
): readonly PointerTrajectorySample[] {
  const offsets = [
    ...new Set([
      ...sampleGestureOffsets(durationMs, 'default'),
      ...canonical.map(({ offsetMs }) => offsetMs),
    ]),
  ].sort((left, right) => left - right);
  let segmentIndex = 0;
  return offsets.map((offsetMs) => {
    while (
      segmentIndex < canonical.length - 2 &&
      offsetMs > canonical[segmentIndex + 1]!.offsetMs
    ) {
      segmentIndex += 1;
    }
    const start = canonical[segmentIndex]!;
    const end = canonical[segmentIndex + 1]!;
    const segmentDurationMs = end.offsetMs - start.offsetMs;
    return {
      offsetMs,
      point:
        offsetMs === end.offsetMs || segmentDurationMs === 0
          ? end.point
          : interpolateGesturePoint(
              start.point,
              end.point,
              (offsetMs - start.offsetMs) / segmentDurationMs,
            ),
    };
  });
}

/** Maps one display-space point into the panel's own axis space. */
function toPanelPoint(
  point: { x: number; y: number },
  transform: HarmonyPanelTransform,
): { x: number; y: number } {
  const { range, displayWidth, displayHeight } = transform;
  return {
    x: Math.round(range.minX + (point.x * (range.maxX - range.minX)) / (displayWidth - 1)),
    y: Math.round(range.minY + (point.y * (range.maxY - range.minY)) / (displayHeight - 1)),
  };
}

function sampleDelayMs(previousOffsetMs: number, offsetMs: number): number {
  return Math.max(0, offsetMs - previousOffsetMs);
}

/** Even-index subset that always keeps both endpoints, capped at the transport budget. */
function subsampleForTransport(
  canonical: readonly PointerTrajectorySample[],
  maxSamples: number,
): readonly PointerTrajectorySample[] {
  if (canonical.length <= maxSamples) return canonical;
  const last = canonical.length - 1;
  const picked = new Map<number, PointerTrajectorySample>();
  for (let index = 0; index < maxSamples; index += 1) {
    const canonicalIndex = Math.round((index * last) / (maxSamples - 1));
    picked.set(canonicalIndex, canonical[canonicalIndex]!);
  }
  return [...picked.entries()].sort(([left], [right]) => left - right).map(([, sample]) => sample);
}

function touchDownEvents(point: { x: number; y: number }): HarmonyTouchEvent[] {
  return [
    abs(ABS_MT_SLOT, INJECTED_MT_SLOT),
    abs(ABS_MT_TRACKING_ID, INJECTED_TRACKING_ID),
    abs(ABS_MT_POSITION_X, Math.round(point.x)),
    abs(ABS_MT_POSITION_Y, Math.round(point.y)),
    key(BTN_TOUCH, 1),
    syn(),
  ];
}

function touchMoveEvents(point: { x: number; y: number }): HarmonyTouchEvent[] {
  return [
    abs(ABS_MT_POSITION_X, Math.round(point.x)),
    abs(ABS_MT_POSITION_Y, Math.round(point.y)),
    syn(),
  ];
}

/** Reports the final point and releases the contact in one frame, so the stroke ends on it. */
function touchUpEvents(point: { x: number; y: number }): HarmonyTouchEvent[] {
  return [
    abs(ABS_MT_POSITION_X, Math.round(point.x)),
    abs(ABS_MT_POSITION_Y, Math.round(point.y)),
    abs(ABS_MT_SLOT, INJECTED_MT_SLOT),
    abs(ABS_MT_TRACKING_ID, -1),
    key(BTN_TOUCH, 0),
    syn(),
  ];
}

function abs(code: number, value: number): HarmonyTouchEvent {
  return { type: EV_ABS, code, value };
}

function key(code: number, value: number): HarmonyTouchEvent {
  return { type: EV_KEY, code, value };
}

function syn(): HarmonyTouchEvent {
  return { type: EV_SYN, code: SYN_REPORT, value: 0 };
}
