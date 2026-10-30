import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { ScrollExecutionOptions } from '@agent-device/contracts/scroll-command';
import {
  buildScrollGesturePlan,
  type ScrollDirection,
} from '@agent-device/contracts/scroll-gesture';
import type {
  ApplicationLaunchReport,
  Interactor,
  ScreenshotOptions,
  SnapshotRuntimeResult,
  SnapshotOptions,
} from '@agent-device/contracts/interactor-types';
import type { DeviceRotation } from '@agent-device/contracts/device';
import {
  AppError,
  discloseDispatch,
  discloseDispatchAfterSteps,
} from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RevylSession } from './revyl-session.ts';
import { captureRevylSnapshot, createRevylSnapshotReader } from './snapshot.ts';

/** Revyl's worker holds the touch this long when the caller names no hold. */
const DEFAULT_LONG_PRESS_DURATION_MS = 1_500;

/**
 * One Revyl session's device actions.
 *
 * Every action is one device-proxy request against the session's run, and the request bodies are
 * Revyl's own: coordinates in the platform's units (iOS points, Android pixels), `clear_first` on
 * text entry, and the session's installed app as the default launch target. Members the worker has
 * no action for are absent rather than faked, and the owner's facts refuse them before they bind.
 */
class RevylInteractor implements Interactor {
  private readonly session: RevylSession;
  /** The cancellation the command came in with, when the runner carried one. */
  private readonly signal: AbortSignal | undefined;

  constructor(session: RevylSession, signal?: AbortSignal) {
    this.session = session;
    this.signal = signal;
  }

  async open(
    app: string,
    options?: { url?: string; launchArgs?: string[] },
  ): Promise<ApplicationLaunchReport | void> {
    const target = app.trim();
    if (options?.url) {
      await this.launch(target, options.launchArgs);
      await this.workerAction('open_url', { url: options.url });
      return target ? { launchedAppBundleId: target } : undefined;
    }
    if (isDeepLinkTarget(target)) {
      await this.workerAction('open_url', { url: target });
      return;
    }
    await this.launch(target, options?.launchArgs);
    return target ? { launchedAppBundleId: target } : undefined;
  }

  /**
   * Revyl's worker launches the app the session installed when the body names none, so a blank
   * target is the honest request here rather than a guessed bundle id. That choice is recorded, since
   * it is the app `/kill_app` will end. Launch arguments have no transport: the worker starts the app
   * the way the platform does, with no process arguments.
   */
  private async launch(app: string, launchArgs?: string[]): Promise<void> {
    if (launchArgs?.length) {
      throw new AppError('UNSUPPORTED_OPERATION', 'Revyl launches an app without arguments.', {
        reason: 'unsupported-provider-mode',
        hint: 'Open a deep link instead: open <url>.',
      });
    }
    await this.workerAction('launch', app ? { bundle_id: app } : {});
    if (app) this.session.launchedApp.bundleId = app;
  }

  /** Revyl rents the device to this session alone; there is no local app or viewer to raise. */
  async openDevice(): Promise<void> {}

  /**
   * Revyl's `/kill_app` carries no bundle id: it ends the app the session runs. So a close that names the
   * app this session launched is that request, and an unnamed close (a relaunch ending whatever runs) is
   * that request too. A close that names a different app, or names any app while this session has
   * launched none, is refused: killing the session's app would report the close of an app this runtime
   * never saw start.
   */
  async close(app: string): Promise<void> {
    const target = app.trim();
    if (target) this.requireCloseableApp(target, this.session.launchedApp.bundleId);
    await this.workerAction('kill_app');
  }

  /** Refuses a close naming an app this session cannot be ending, and names the one it would end. */
  private requireCloseableApp(target: string, sessionApp: string | undefined): void {
    if (sessionApp === undefined) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        `This Revyl session has not launched ${target}, so it has no app to end.`,
        {
          reason: 'provider-app-not-launched',
          command: 'close',
          requestedApp: target,
          hint: 'Close without an app name to end the app this session runs, or open the app first.',
        },
      );
    }
    if (target === sessionApp) return;
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Revyl ends the app this session launched (${sessionApp}), not ${target}.`,
      {
        reason: 'unsupported-provider-mode',
        command: 'close',
        sessionApp,
        requestedApp: target,
        hint: 'Revyl has no way to name an app to `/kill_app`; end the session to stop what it runs.',
      },
    );
  }

  async tap(x: number, y: number): Promise<void> {
    await this.workerAction('tap', { x, y });
  }

  /** One fused double-tap: the worker sends both presses, so no round trip lands between them. */
  async doubleTap(x: number, y: number): Promise<void> {
    await this.workerAction('double_tap', { x, y });
  }

  async longPress(
    x: number,
    y: number,
    durationMs = DEFAULT_LONG_PRESS_DURATION_MS,
  ): Promise<void> {
    await this.workerAction('longpress', { x, y, duration_ms: durationMs });
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  /**
   * Revyl has no coordinate-free text injection: its `/input` action takes the field's point and
   * types there. The text-entry commands that name a point reach the device through `fill`.
   */
  type(): never {
    throw unsupported(
      'type',
      'Revyl enters text at a point; run fill <field> "text" instead of type.',
    );
  }

  /**
   * Replaces the field's text. The empty string is the clear request, and Revyl's `/clear_text`
   * action is the one action that empties a field without typing, so it rides that rather than
   * reporting success over an untouched value.
   *
   * A per-character delay is honored the way the local providers honor one: the text goes one
   * character at a time with the pause between them. Revyl's `/input` has no pacing field, so a
   * paced fill that fails partway names how much of the text already landed. The pause is canceled
   * with the command that asked for it, so a canceled fill stops at the character it reached instead
   * of waiting out the delay and typing another.
   */
  async fill(
    x: number,
    y: number,
    text: string,
    delayMs?: number,
    _options?: { allowNonHittableCoordinateFallback?: boolean },
  ): Promise<void> {
    if (text === '') {
      await this.workerAction('clear_text', { x, y });
      return;
    }
    if (!delayMs || delayMs <= 0) {
      await this.workerAction('input', { x, y, text, clear_first: true });
      return;
    }
    let dispatched = 0;
    const chars = Array.from(text);
    try {
      for (const [index, char] of chars.entries()) {
        if (this.signal?.aborted) {
          // Before the first character nothing has reached the device, which is a settled verdict.
          throw dispatched === 0
            ? discloseDispatch(this.cancellation(), 'no')
            : this.cancellation();
        }
        // Only the first character clears: the rest append to what the field already holds.
        await this.workerAction('input', { x, y, text: char, clear_first: dispatched === 0 });
        dispatched += 1;
        // The pause goes *between* characters, so the last one has none left to wait out: a caller that
        // hangs up after the whole text reached the device must not be told its fill was canceled.
        if (index === chars.length - 1) return;
        await sleep(delayMs, undefined, this.signal === undefined ? {} : { signal: this.signal });
      }
    } catch (error) {
      // A pause cut short by the command's signal rejects with the timer's own AbortError, which says
      // nothing about the fill it stopped or how far that fill got.
      throw discloseDispatchAfterSteps(this.canceledAs(error), dispatched);
    }
  }

  /**
   * One directional scroll as one drag of the planned finger path.
   *
   * The path comes from the same planner the local devices use, so the distance, the edge insets and
   * the container clamp mean the same thing here as they do locally, and the report carries the same
   * `pixels` and endpoints. Revyl's own `/swipe` is not used: it moves the finger a distance the
   * worker chooses, so `--pixels` and `--amount` would be silently dropped.
   *
   * Revyl's `/drag` body carries endpoints only — no duration field exists — so the worker chooses
   * how fast the finger travels and the report names no `durationMs`. `scroll --duration-ms` is therefore
   * refused: a drag that ran at Revyl's own speed while reporting the caller's number would be a false
   * echo, and one that said nothing would drop what the caller asked for.
   */
  async scroll(
    direction: ScrollDirection,
    options?: ScrollExecutionOptions,
  ): Promise<Record<string, unknown>> {
    if (options?.durationMs !== undefined) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'Revyl scrolls with one drag and cannot be told how fast the finger travels.',
        {
          reason: 'unsupported-provider-mode',
          command: 'scroll',
          flag: '--duration-ms',
          runId: this.session.runId,
          hint: 'Scroll without --duration-ms; the drag runs at the speed Revyl gives it.',
        },
      );
    }
    const screen = this.session.screen;
    if (!screen) {
      throw new AppError(
        'COMMAND_FAILED',
        'Revyl reported no screen size for this session, so the scroll distance cannot be planned.',
        { reason: 'provider-viewport-unavailable', runId: this.session.runId },
      );
    }
    const plan = buildScrollGesturePlan({
      direction,
      ...(options?.amount === undefined ? {} : { amount: options.amount }),
      ...(options?.pixels === undefined ? {} : { pixels: options.pixels }),
      referenceWidth: screen.width,
      referenceHeight: screen.height,
      ...(options?.containerRect === undefined
        ? {}
        : {
            container: relativeToViewport(options.containerRect, screen),
          }),
    });
    await this.workerAction('drag', {
      start_x: plan.x1,
      start_y: plan.y1,
      end_x: plan.x2,
      end_y: plan.y2,
    });
    return {
      ...plan,
      backend: 'revyl-device-proxy',
    };
  }

  /**
   * Writes through a temporary file in the same directory and renames it into place, so a caller that
   * hangs up mid-write or a process that dies leaves either the previous screenshot or none at all, and
   * never a truncated PNG at the path the caller asked for. The name is unique per capture: two sessions
   * writing the same base name in one process must not collide on one temporary file.
   *
   * An iOS capture arrives at the simulator's native scale (3x on current iPhones). The host reports an
   * iOS simulator screenshot at the requested pixel density, 1x by default, which is also the point
   * space taps use, so the image is rescaled from the density `health`'s point size implies.
   */
  async screenshot(outPath: string, options?: ScreenshotOptions): Promise<void> {
    const png = await this.session.client.captureWorkerScreenshot(this.session.runId, this.signal);
    const directory = path.dirname(outPath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(outPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.promises.writeFile(
        temporaryPath,
        png,
        this.signal === undefined ? {} : { signal: this.signal },
      );
      if (this.session.platform === 'ios') {
        await normalizeRevylIosDensity(temporaryPath, this.session.screen, options?.pixelDensity);
      }
      // The capture is over once the PNG is in hand, but a caller that hung up during the write is not
      // owed the rename: the file it canceled is unlinked rather than published.
      if (this.signal?.aborted === true) throw this.cancellation();
      await fs.promises.rename(temporaryPath, outPath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      // A write the signal cut short rejects with a bare AbortError; the caller is owed the typed
      // cancellation that names the action it stopped.
      throw this.canceledAs(error);
    }
  }

  async snapshot(options?: SnapshotOptions): Promise<SnapshotRuntimeResult> {
    return await captureRevylSnapshot(
      this.session,
      createRevylSnapshotReader(this.session),
      options?.signal ?? this.signal,
    );
  }

  async back(): Promise<void> {
    await this.workerAction('back');
  }

  async home(): Promise<void> {
    await this.workerAction('go_home');
  }

  /** Revyl keeps the device in the orientation its session started in; no action rotates it. */
  setOrientation(_orientation: DeviceRotation): never {
    throw unsupported('orientation', 'Revyl does not expose orientation control.');
  }

  setSetting(): never {
    throw unsupported('settings', 'Revyl does not expose settings control.');
  }

  /**
   * The typed cancellation for this command's signal, caused by whatever the interrupted wait rejected
   * with. The device-proxy path reports its own cancellations; this covers the waits in between, whose
   * timer rejects with a bare AbortError that says nothing about the fill it stopped.
   */
  private cancellation(cause?: unknown): AppError {
    return new AppError(
      'COMMAND_FAILED',
      'The Revyl action was canceled before it finished.',
      { reason: 'request_canceled', runId: this.session.runId },
      cause ?? this.signal?.reason,
    );
  }

  /** A failure that arrived while the command's signal was aborted becomes that cancellation. */
  private canceledAs(error: unknown): unknown {
    if (!this.signal?.aborted || error instanceof AppError) return error;
    return this.cancellation(error);
  }

  /** Sends one device-proxy action and reports a refusal the worker returned inside a 200 body. */
  private workerAction(
    action: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.session.client.workerAction(this.session.runId, action, body, this.signal);
  }
}

export function createRevylInteractor(session: RevylSession, signal?: AbortSignal): Interactor {
  return new RevylInteractor(session, signal);
}

/** Rescales an iOS capture from the density its point size implies to the one the caller asked for. */
async function normalizeRevylIosDensity(
  file: string,
  screen: { width: number } | undefined,
  pixelDensity: number | undefined,
): Promise<void> {
  // The host reports the requested density for every iOS simulator capture, so an image whose source
  // density is unknown cannot be published under that claim.
  if (screen === undefined) {
    throw new AppError(
      'COMMAND_FAILED',
      'Revyl reported no screen size for this session, so the screenshot density cannot be known.',
      { reason: 'provider-viewport-unavailable' },
    );
  }
  const [{ readPngSize }, { resizePngFile }, { computeDensityScaledScreenshotSize }] =
    await Promise.all([
      import('@agent-device/capture-kit/png-size'),
      import('@agent-device/capture-kit/png-resize'),
      import('@agent-device/capture-kit/screenshot-density'),
    ]);
  const size = await readPngSize(file);
  const target = computeDensityScaledScreenshotSize(size, size.width / screen.width, pixelDensity);
  if (target) await resizePngFile(file, target.width, target.height);
}

/** The plan works in a zero-origin box; a snapshot container's rect is in the same space here. */
function relativeToViewport(
  rect: { x: number; y: number; width: number; height: number },
  screen: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(rect.width, screen.width);
  const height = Math.min(rect.height, screen.height);
  return {
    x: Math.max(0, Math.min(rect.x, screen.width - width)),
    y: Math.max(0, Math.min(rect.y, screen.height - height)),
    width,
    height,
  };
}

function unsupported(command: string, message: string): AppError {
  return new AppError('UNSUPPORTED_OPERATION', message, {
    reason: 'unsupported-provider-mode',
    command,
  });
}
