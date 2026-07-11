import { AppError } from '../kernel/errors.ts';
import {
  isIosFamily,
  isMacOs,
  isTvOsDevice,
  publicPlatformString,
  type DeviceInfo,
} from '../kernel/device.ts';
import { successText, withSuccessText } from '../utils/success-text.ts';
import { findMistargetedTypeRefToken } from '../utils/type-target-warning.ts';
import { parseScrollDirection, type ScrollDirection } from '../contracts/scroll-gesture.ts';
import {
  assertExclusiveScrollDistanceInputs,
  honoredScrollDurationMs,
  normalizeScrollDurationMs,
  type ScrollCommandOptions,
} from '../contracts/scroll-command.ts';
import {
  getClickButtonValidationError,
  resolveClickButton,
  type ClickButton,
} from './click-button.ts';
import {
  captureScrollEdgeState,
  formatScrollEdgeMessage,
  runScrollEdgePasses,
  type ScrollEdge,
  type ScrollEdgeState,
} from '../utils/scroll-edge-state.ts';
import {
  requireIntInRange,
  shouldUseIosPressSequence,
  chunkRunnerSequenceStepsByBudget,
  computeDeterministicJitter,
  runRepeatedSeries,
} from './dispatch-series.ts';
import type { RunnerSequenceStep } from '../platforms/apple/core/runner/runner-contract.ts';
import type { DispatchContext } from './dispatch-context.ts';
import {
  MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE,
  type Interactor,
  type RunnerCallOptions,
} from './interactor-types.ts';

type ScrollTarget = {
  direction: ScrollDirection;
  edge?: ScrollEdge;
};

export async function handleLongPressCommand(
  interactor: Interactor,
  positionals: string[],
): Promise<Record<string, unknown>> {
  const { x, y } = readPoint(positionals, 'longpress requires x y [durationMs]', {
    hint: 'Direct platform longpress requires coordinates. In an open daemon session, use agent-device longpress @ref|selector [durationMs]; otherwise run snapshot -i, use the target rect center as x y, then retry longpress x y durationMs.',
  });
  const durationMs = positionals[2] ? Number(positionals[2]) : undefined;
  await interactor.longPress(x, y, durationMs);
  return { x, y, durationMs, ...successText(`Long pressed (${x}, ${y})`) };
}

export async function handleFocusCommand(
  interactor: Interactor,
  positionals: string[],
): Promise<Record<string, unknown>> {
  const { x, y } = readPoint(positionals, 'focus requires x y');
  await interactor.focus(x, y);
  return { x, y, ...successText(`Focused (${x}, ${y})`) };
}

export async function handleTypeCommand(
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const mistargetedRef = findMistargetedTypeRef(positionals);
  if (mistargetedRef) {
    throw new AppError(
      'INVALID_ARGS',
      `type does not accept a target ref like "${mistargetedRef}"`,
      {
        hint: `Use fill ${mistargetedRef} "text" to target that field, or press ${mistargetedRef} then type "text" to append.`,
      },
    );
  }
  const text = positionals.join(' ');
  if (!text) throw new AppError('INVALID_ARGS', 'type requires text');
  const delayMs = requireIntInRange(context?.delayMs ?? 0, 'delay-ms', 0, 10_000);
  await interactor.type(text, delayMs);
  return { text, delayMs, ...successText(formatTextLengthMessage('Typed', text)) };
}

export async function handleFillCommand(
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  if (context?.directElementSelector) {
    return await handleDirectElementSelectorFill(
      interactor,
      context.directElementSelector,
      positionals,
      context,
    );
  }

  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  const text = positionals.slice(2).join(' ');
  if (Number.isNaN(x) || Number.isNaN(y) || !text) {
    throw new AppError('INVALID_ARGS', 'fill requires x y text');
  }
  const delayMs = requireIntInRange(context?.delayMs ?? 0, 'delay-ms', 0, 10_000);
  await interactor.fill(x, y, text, delayMs);
  return { x, y, text, delayMs, ...successText(formatTextLengthMessage('Filled', text)) };
}

async function handleDirectElementSelectorFill(
  interactor: Interactor,
  selector: NonNullable<DispatchContext['directElementSelector']>,
  positionals: string[],
  context: DispatchContext,
): Promise<Record<string, unknown>> {
  if (!interactor.fillElementSelector) {
    throw new AppError('UNSUPPORTED_OPERATION', 'direct element selector fill is not supported');
  }
  const text = positionals.join(' ');
  if (!text) throw new AppError('INVALID_ARGS', 'fill requires text');
  const delayMs = requireIntInRange(context.delayMs ?? 0, 'delay-ms', 0, 10_000);
  const result = await interactor.fillElementSelector(selector, text, delayMs);
  return {
    selector: selector.raw,
    text,
    delayMs,
    ...(result ?? {}),
    ...successText(formatTextLengthMessage('Filled', text)),
  };
}

export async function handlePressCommand(
  device: DeviceInfo,
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  if (context?.directElementSelector && isIosFamily(device)) {
    return await handleDirectElementSelectorPress(interactor, context.directElementSelector);
  }

  const { x, y } = readPoint(positionals, 'press requires x y');

  if (isMacOs(device) && context?.surface && context.surface !== 'app') {
    return await handleMacOsSurfacePress(x, y, context);
  }

  const clickButton = resolveClickButton(context);
  if (clickButton !== 'primary') {
    return await handleAlternateClick(device, x, y, clickButton, context);
  }

  const series = readPressSeriesOptions(context);
  validatePressSeriesOptions(series);

  if (shouldUseIosPressSequence(device, series.count)) {
    return await runIosPressSequence(device, x, y, series, context);
  }

  return await runDirectPressSeries(interactor, x, y, series);
}

async function handleDirectElementSelectorPress(
  interactor: Interactor,
  selector: NonNullable<DispatchContext['directElementSelector']>,
): Promise<Record<string, unknown>> {
  if (!interactor.tapElementSelector) {
    throw new AppError('UNSUPPORTED_OPERATION', 'direct element selector tap is not supported');
  }
  const result = await interactor.tapElementSelector(selector);
  // Keep the fallback success text for backward compatibility, but read usage
  // from the runner's structured result so fill and tap share the same signal.
  const usedNonHittableFallback = result?.maestroNonHittableCoordinateFallbackUsed === true;
  return {
    selector: selector.raw,
    ...(result ?? {}),
    ...successText(
      usedNonHittableFallback ? MAESTRO_NON_HITTABLE_FALLBACK_MESSAGE : `Tapped ${selector.raw}`,
    ),
  };
}

type Point = { x: number; y: number };

type PressSeriesOptions = {
  count: number;
  intervalMs: number;
  holdMs: number;
  jitterPx: number;
  doubleTap: boolean;
};

function readPoint(
  positionals: string[],
  errorMessage: string,
  details?: Record<string, unknown>,
): Point {
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    throw new AppError('INVALID_ARGS', errorMessage, details);
  }
  return { x, y };
}

async function handleMacOsSurfacePress(
  x: number,
  y: number,
  context: DispatchContext,
): Promise<Record<string, unknown>> {
  const clickButton = resolveClickButton(context);
  if (clickButton !== 'primary') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `${clickButton} click is not supported on macOS ${context.surface} sessions.`,
    );
  }
  const { runMacOsPressAction } = await import('../platforms/apple/os/macos/helper.ts');
  await runMacOsPressAction(x, y, {
    bundleId: context.appBundleId,
    surface: context.surface,
  });
  return { x, y, ...successText(formatPressMessage({ x, y })) };
}

async function handleAlternateClick(
  device: DeviceInfo,
  x: number,
  y: number,
  button: ClickButton,
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  assertAlternateClickSupported(device, button, context);
  if (device.platform === 'linux') {
    return await runLinuxAlternateClick(x, y, button);
  }
  const { runAppleRunnerCommand } = await import('../platforms/apple/core/runner/runner-client.ts');
  await runAppleRunnerCommand(
    device,
    {
      command: 'mouseClick',
      x,
      y,
      button,
      appBundleId: context?.appBundleId,
    },
    runnerOptionsFromContext(context),
  );
  return {
    x,
    y,
    button,
    ...successText(formatPressMessage({ x, y, button })),
  };
}

function assertAlternateClickSupported(
  device: DeviceInfo,
  button: ClickButton,
  context: DispatchContext | undefined,
): void {
  const validationError = getClickButtonValidationError({
    commandLabel: 'click',
    platform: publicPlatformString(device),
    button,
    count: context?.count,
    intervalMs: context?.intervalMs,
    holdMs: context?.holdMs,
    jitterPx: context?.jitterPx,
    doubleTap: context?.doubleTap,
  });
  if (validationError) {
    throw validationError;
  }
}

async function runLinuxAlternateClick(
  x: number,
  y: number,
  button: ClickButton,
): Promise<Record<string, unknown>> {
  if (button === 'secondary') {
    const { rightClickLinux } = await import('../platforms/linux/input-actions.ts');
    await rightClickLinux(x, y);
  } else {
    const { middleClickLinux } = await import('../platforms/linux/input-actions.ts');
    await middleClickLinux(x, y);
  }
  return {
    x,
    y,
    button,
    ...successText(formatPressMessage({ x, y, button })),
  };
}

function readPressSeriesOptions(context: DispatchContext | undefined): PressSeriesOptions {
  return {
    count: readContextInt(context?.count, 1, 'count', 1, 200),
    intervalMs: readContextInt(context?.intervalMs, 0, 'interval-ms', 0, 10_000),
    holdMs: readContextInt(context?.holdMs, 0, 'hold-ms', 0, 10_000),
    jitterPx: readContextInt(context?.jitterPx, 0, 'jitter-px', 0, 100),
    doubleTap: Boolean(context?.doubleTap),
  };
}

function readContextInt(
  value: number | undefined,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number {
  return requireIntInRange(value === undefined ? fallback : value, label, min, max);
}

function validatePressSeriesOptions({ doubleTap, holdMs, jitterPx }: PressSeriesOptions): void {
  if (doubleTap && holdMs > 0) {
    throw new AppError('INVALID_ARGS', 'double-tap cannot be combined with hold-ms');
  }
  if (doubleTap && jitterPx > 0) {
    throw new AppError('INVALID_ARGS', 'double-tap cannot be combined with jitter-px');
  }
}

// Runs an ordered step list as budget-chunked `sequence` runner requests and aggregates the
// chunk responses. Chunks are bounded by BOTH a step-count cap and an estimated wall-clock
// budget so no single request risks the runner's 30s main-thread watchdog. Stops at the first
// chunk reporting a failed step (mapped to an AppError with the global step index). The
// aggregate keeps the first chunk's frame/x/y/gestureStart, the last chunk's gestureEnd, summed
// completedSteps, and concatenated sequenceResults so recording-gestures and response shaping
// see the whole series, not just the first chunk.
async function runIosSequenceChunks(
  device: DeviceInfo,
  steps: RunnerSequenceStep[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const { runAppleRunnerCommand } = await import('../platforms/apple/core/runner/runner-client.ts');
  const { MAX_RUNNER_SEQUENCE_STEPS, buildRunnerSequenceCommand, parseRunnerSequenceResult } =
    await import('../platforms/apple/core/runner/runner-sequence.ts');
  const chunks = chunkRunnerSequenceStepsByBudget(steps, MAX_RUNNER_SEQUENCE_STEPS);

  let firstChunkRunnerResult: Record<string, unknown> | undefined;
  let lastChunkRunnerResult: Record<string, unknown> | undefined;
  let completedSteps = 0;
  const sequenceResults: unknown[] = [];
  let stepOffset = 0;
  for (const chunk of chunks) {
    const runnerResult = await runAppleRunnerCommand(
      device,
      buildRunnerSequenceCommand(chunk, context?.appBundleId),
      runnerOptionsFromContext(context),
    );
    firstChunkRunnerResult ??= runnerResult;
    lastChunkRunnerResult = runnerResult;
    let parsed;
    try {
      parsed = parseRunnerSequenceResult(runnerResult);
    } catch (error) {
      throw remapSequenceErrorStepIndex(error, stepOffset);
    }
    completedSteps += parsed.completedSteps;
    sequenceResults.push(...parsed.results);
    stepOffset += chunk.length;
  }

  return {
    ...(firstChunkRunnerResult ?? {}),
    completedSteps,
    sequenceResults,
    ...(lastChunkRunnerResult?.gestureEndUptimeMs !== undefined
      ? { gestureEndUptimeMs: lastChunkRunnerResult.gestureEndUptimeMs }
      : {}),
  };
}

// Fuses an iOS press series — plain, double-tap, hold, and jitter variants — into `sequence`
// runner requests, replacing both the retired `tapSeries` runner command and the N-request
// runDirectPressSeries fallback.
async function runIosPressSequence(
  device: DeviceInfo,
  x: number,
  y: number,
  series: PressSeriesOptions,
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const aggregated = await runIosSequenceChunks(
    device,
    buildPressSequenceSteps(device, x, y, series),
    context,
  );
  return {
    x,
    y,
    count: series.count,
    intervalMs: series.intervalMs,
    holdMs: series.holdMs,
    jitterPx: series.jitterPx,
    doubleTap: series.doubleTap,
    timingMode: 'runner-sequence',
    ...aggregated,
    ...successText(formatPressMessage({ x, y })),
  };
}

function buildPressSequenceSteps(
  device: DeviceInfo,
  x: number,
  y: number,
  series: PressSeriesOptions,
): RunnerSequenceStep[] {
  const kind = series.doubleTap ? 'doubleTap' : series.holdMs > 0 ? 'longPress' : 'tap';
  // Mirror the individual `tap` command: on touch-input iOS (not the tvOS leaf), tap steps
  // use synthesized HID taps (synthesizedTapAt) rather than the drag-based XCUICoordinate
  // tapAt, matching iosTapCommand.
  const synthesized = kind === 'tap' && isIosFamily(device) && !isTvOsDevice(device);
  return Array.from({ length: series.count }, (_, index) => {
    const [dx, dy] = computeDeterministicJitter(index, series.jitterPx);
    const isLast = index === series.count - 1;
    return {
      kind,
      x: x + dx,
      y: y + dy,
      ...(synthesized ? { synthesized: true } : {}),
      ...(series.holdMs > 0 ? { durationMs: series.holdMs } : {}),
      ...(!isLast && series.intervalMs > 0 ? { pauseMs: series.intervalMs } : {}),
    };
  });
}

// Sequence step errors carry a chunk-local failedStepIndex and completedSteps; rebase both onto the
// global series so the error names the true step and completed count across chunk boundaries.
function remapSequenceErrorStepIndex(error: unknown, stepOffset: number): unknown {
  if (stepOffset === 0 || !(error instanceof AppError) || !error.details) return error;
  const localIndex = error.details.failedStepIndex;
  if (typeof localIndex !== 'number') return error;
  const localCompletedSteps = error.details.completedSteps;
  return new AppError(
    error.code,
    error.message,
    {
      ...error.details,
      failedStepIndex: localIndex + stepOffset,
      chunkStepIndex: localIndex,
      ...(typeof localCompletedSteps === 'number'
        ? { completedSteps: stepOffset + localCompletedSteps }
        : {}),
    },
    error.cause,
  );
}

async function runDirectPressSeries(
  interactor: Interactor,
  x: number,
  y: number,
  series: PressSeriesOptions,
): Promise<Record<string, unknown>> {
  let interactionResult: Record<string, unknown> | undefined;
  await runRepeatedSeries(series.count, series.intervalMs, async (index) => {
    const [dx, dy] = computeDeterministicJitter(index, series.jitterPx);
    const targetX = x + dx;
    const targetY = y + dy;
    // `??=` must not guard the awaited call itself: that would short-circuit
    // every press after the first. Only the first result is kept.
    if (series.doubleTap) {
      const result = await interactor.doubleTap(targetX, targetY);
      interactionResult ??= result ?? undefined;
      return;
    }
    if (series.holdMs > 0) {
      const result = await interactor.longPress(targetX, targetY, series.holdMs);
      interactionResult ??= result ?? undefined;
    } else {
      const result = await interactor.tap(targetX, targetY);
      interactionResult ??= result ?? undefined;
    }
  });

  return withSuccessText(
    {
      x,
      y,
      count: series.count,
      intervalMs: series.intervalMs,
      holdMs: series.holdMs,
      jitterPx: series.jitterPx,
      doubleTap: series.doubleTap,
      ...interactionResult,
    },
    formatPressMessage({ x, y }),
  );
}

function runnerOptionsFromContext(context: DispatchContext | undefined): RunnerCallOptions {
  return {
    verbose: context?.verbose,
    logPath: context?.logPath,
    traceLogPath: context?.traceLogPath,
    requestId: context?.requestId,
    iosXctestrunFile: context?.iosXctestrunFile,
    iosXctestDerivedDataPath: context?.iosXctestDerivedDataPath,
    iosXctestEnvDir: context?.iosXctestEnvDir,
  };
}

export async function handleScrollCommand(
  interactor: Interactor,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const directionInput = positionals[0];
  const amount = positionals[1] ? Number(positionals[1]) : undefined;
  const pixels = context?.pixels;
  const durationMs = context?.durationMs;
  if (!directionInput) throw new AppError('INVALID_ARGS', 'scroll requires direction');
  assertScrollCommandInputs(amount, pixels, durationMs);

  const target = parseScrollTarget(directionInput);
  const options = { amount, pixels, durationMs };
  const { interactionResult, completedPasses } = await runDispatchedScroll(
    interactor,
    context,
    target,
    options,
  );

  const result = buildDispatchedScrollResult(target, options, completedPasses, interactionResult);
  return withSuccessText(
    result,
    formatScrollEdgeMessage(target.direction, target.edge, completedPasses, amount, pixels),
  );
}

function assertScrollCommandInputs(
  amount: number | undefined,
  pixels: number | undefined,
  durationMs: number | undefined,
): void {
  assertScrollAmountInput(amount);
  normalizeScrollDurationMs(durationMs);
  assertExclusiveScrollDistanceInputs({ amount, pixels });
}

function assertScrollAmountInput(amount: number | undefined): void {
  if (amount !== undefined && !Number.isFinite(amount)) {
    throw new AppError('INVALID_ARGS', 'scroll amount must be a number');
  }
}

async function runDispatchedScroll(
  interactor: Interactor,
  context: DispatchContext | undefined,
  target: ScrollTarget,
  options: ScrollCommandOptions,
): Promise<{ interactionResult: Record<string, unknown>; completedPasses: number }> {
  if (target.edge) {
    const edge = target.edge;
    const edgeResult = await runScrollEdgePasses({
      edge,
      captureState: async (scope) =>
        await captureVerifiedScrollEdgeState(interactor, context, edge, scope),
      scroll: async () => await interactor.scroll(target.direction, options),
    });
    return {
      interactionResult: edgeResult.result ?? {},
      completedPasses: edgeResult.passes,
    };
  }

  return {
    interactionResult: (await interactor.scroll(target.direction, options)) ?? {},
    completedPasses: 1,
  };
}

function buildDispatchedScrollResult(
  target: ScrollTarget,
  options: ScrollCommandOptions,
  completedPasses: number,
  interactionResult: Record<string, unknown>,
): Record<string, unknown> {
  const durationMs = honoredScrollDurationMs(interactionResult);
  return {
    direction: target.direction,
    ...(target.edge ? { edge: target.edge, passes: completedPasses } : {}),
    ...(options.amount !== undefined ? { amount: options.amount } : {}),
    ...(options.pixels !== undefined ? { pixels: options.pixels } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...interactionResult,
  };
}

async function captureVerifiedScrollEdgeState(
  interactor: Interactor,
  context: DispatchContext | undefined,
  edge: ScrollEdge,
  scope?: string,
): Promise<ScrollEdgeState> {
  if (typeof interactor.snapshot !== 'function') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `scroll ${edge} requires snapshot support to verify hidden content before scrolling`,
    );
  }
  const snapshot = interactor.snapshot;
  return await captureScrollEdgeState({
    edge,
    scope,
    captureNodes: async (snapshotScope) =>
      (
        await snapshot({
          appBundleId: context?.appBundleId,
          scope: snapshotScope,
        })
      ).nodes ?? [],
  });
}

function parseScrollTarget(input: string): {
  direction: ReturnType<typeof parseScrollDirection>;
  edge?: 'top' | 'bottom';
} {
  if (input === 'bottom') return { direction: 'down', edge: 'bottom' };
  if (input === 'top') return { direction: 'up', edge: 'top' };
  return { direction: parseScrollDirection(input) };
}

export async function handleReadCommand(
  device: DeviceInfo,
  positionals: string[],
  context: DispatchContext | undefined,
): Promise<Record<string, unknown>> {
  const { x, y } = readPoint(positionals, 'read requires x y');
  if (device.platform === 'android') {
    const { readAndroidTextAtPoint } = await import('../platforms/android/input-actions.ts');
    const text = await readAndroidTextAtPoint(device, x, y);
    return { action: 'read', text: text ?? '' };
  }
  if (device.platform === 'linux') {
    const { readLinuxTextAtPoint } = await import('../platforms/linux/snapshot.ts');
    const text = await readLinuxTextAtPoint(x, y, context?.surface);
    return { action: 'read', text };
  }
  if (isMacOs(device) && context?.surface && context.surface !== 'app') {
    const { runMacOsReadTextAction } = await import('../platforms/apple/os/macos/helper.ts');
    const result = await runMacOsReadTextAction(x, y, {
      bundleId: context.appBundleId,
      surface: context.surface,
    });
    return { action: 'read', text: result.text };
  }
  // macOS app sessions run through the XCUITest runner; only desktop/menubar surfaces use the helper.
  const { runAppleRunnerCommand } = await import('../platforms/apple/core/runner/runner-client.ts');
  const result = await runAppleRunnerCommand(
    device,
    {
      command: 'readText',
      x,
      y,
      appBundleId: context?.appBundleId,
    },
    {
      verbose: context?.verbose,
      logPath: context?.logPath,
      traceLogPath: context?.traceLogPath,
      requestId: context?.requestId,
      iosXctestrunFile: context?.iosXctestrunFile,
      iosXctestDerivedDataPath: context?.iosXctestDerivedDataPath,
      iosXctestEnvDir: context?.iosXctestEnvDir,
    },
  );
  const text =
    typeof result.text === 'string'
      ? result.text
      : typeof result.message === 'string'
        ? result.message
        : '';
  return { action: 'read', text };
}

function findMistargetedTypeRef(positionals: string[]): string | null {
  return findMistargetedTypeRefToken(positionals[0]);
}

function formatPressMessage(params: { x: number; y: number; button?: ClickButton }): string {
  if (params.button && params.button !== 'primary') {
    return `Clicked ${params.button} (${params.x}, ${params.y})`;
  }
  return `Tapped (${params.x}, ${params.y})`;
}

function formatTextLengthMessage(action: 'Typed' | 'Filled', text: string): string {
  return `${action} ${Array.from(text).length} chars`;
}
