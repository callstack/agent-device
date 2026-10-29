import fs from 'node:fs';
import path from 'node:path';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import {
  DEFAULT_MOBILE_SCROLL_DURATION_MS,
  type ScrollExecutionOptions,
} from '@agent-device/contracts/scroll-command';
import {
  buildScrollGesturePlan,
  type ScrollDirection,
} from '@agent-device/contracts/scroll-gesture';
import type {
  ApplicationLaunchReport,
  Interactor,
  SnapshotRuntimeResult,
  SnapshotOptions,
} from '@agent-device/contracts/interactor-types';
import type { DeviceRotation } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
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

  constructor(session: RevylSession) {
    this.session = session;
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
   * target is the honest request here rather than a guessed bundle id. Launch arguments have no
   * transport: the worker starts the app the way the platform does, with no process arguments.
   */
  private async launch(app: string, launchArgs?: string[]): Promise<void> {
    if (launchArgs?.length) {
      throw new AppError('UNSUPPORTED_OPERATION', 'Revyl launches an app without arguments.', {
        reason: 'unsupported-provider-mode',
        hint: 'Open a deep link instead: open <url>.',
      });
    }
    await this.workerAction('launch', app ? { bundle_id: app } : {});
  }

  /** Revyl rents the device to this session alone; there is no local app or viewer to raise. */
  async openDevice(): Promise<void> {}

  /**
   * Revyl's worker terminates the app the session runs; its `/kill_app` action names no bundle. So
   * the app the caller passed is what the session's own app is, and closing without a name still
   * closes it — which is what `close` means for a session that rents one device for one app.
   */
  async close(): Promise<void> {
    await this.workerAction('kill_app');
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
   */
  async fill(
    x: number,
    y: number,
    text: string,
    _delayMs?: number,
    _options?: { allowNonHittableCoordinateFallback?: boolean },
  ): Promise<void> {
    if (text === '') {
      await this.workerAction('clear_text', { x, y });
      return;
    }
    await this.workerAction('input', { x, y, text, clear_first: true });
  }

  /**
   * One directional scroll as one drag of the planned finger path.
   *
   * The path comes from the same planner the local devices use, so the distance, the edge insets and
   * the container clamp mean the same thing here as they do locally, and the report carries the same
   * `pixels` and endpoints. Revyl's own `/swipe` is not used: it moves the finger a distance the
   * worker chooses, so `--pixels` and `--amount` would be silently dropped.
   */
  async scroll(
    direction: ScrollDirection,
    options?: ScrollExecutionOptions,
  ): Promise<Record<string, unknown>> {
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
      durationMs: options?.durationMs ?? DEFAULT_MOBILE_SCROLL_DURATION_MS,
      backend: 'revyl-device-proxy',
    };
  }

  async screenshot(outPath: string): Promise<void> {
    const png = await this.session.client.captureWorkerScreenshot(this.session.runId);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await fs.promises.writeFile(outPath, png);
  }

  async snapshot(options?: SnapshotOptions): Promise<SnapshotRuntimeResult> {
    return await captureRevylSnapshot(
      this.session,
      createRevylSnapshotReader(this.session),
      options?.signal,
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

  /** Sends one device-proxy action and reports a refusal the worker returned inside a 200 body. */
  private workerAction(
    action: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.session.client.workerAction(this.session.runId, action, body);
  }
}

export function createRevylInteractor(session: RevylSession): Interactor {
  return new RevylInteractor(session);
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
