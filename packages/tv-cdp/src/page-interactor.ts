import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { shapeDesktopSurfaceSnapshot } from '@agent-device/capture-kit/snapshot-desktop-projection';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { TvRemoteButton } from '@agent-device/contracts/tv-remote';
import { Deadline, pollUntilSettled } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

import { connectCdp, listTargets } from './cdp.ts';
import { keyEvents, supportedRemoteButtons, type RemoteKeys } from './keys.ts';
import { createPageLog, type PageLog } from './page-log.ts';
import { SNAPSHOT_EXPRESSION, type SnapshotCapture } from './snapshot.ts';
import type { PageTunnel, TvSession } from './tv.ts';

const TARGET_WATCH_INTERVAL_MS = 1000;

const isInteractiveElement = (node: RawSnapshotNode) =>
  Boolean(node.hittable || node.editable || node.focused);
const READY_EXPRESSION = "document.readyState === 'complete' && !!document.body";
const SELECT_FOCUSED_CONTENTS = `(function () {
  var el = document.activeElement;
  if (!el) return;
  if (el.select) el.select();
  else if (el.isContentEditable) document.execCommand('selectAll');
})()`;

async function attachPage(
  session: TvSession,
  appId: string,
  tunnel: PageTunnel,
  timeoutMs = 30_000,
) {
  try {
    const page = await connectCdp(tunnel.target);
    session.page = page;
    page.onClose(() => {
      if (session.page === page) detachPage(session);
    });
    tunnel.onClose(() => {
      if (session.tunnel === tunnel) detachPage(session);
    });
    page.on(appLog(session, appId).record);
    await Promise.all(['Runtime.enable', 'Log.enable'].map((method) => page.send(method)));
    // A launch can reload an app that was already running, so the page this connects to may
    // still be loading.
    const { settled: loaded } = await pollUntilSettled({
      deadline: Deadline.fromTimeoutMs(timeoutMs),
      intervalMs: 250,
      settled: (ready) => ready,
      probe: async () => await page.evaluate<boolean>(READY_EXPRESSION).catch(() => false),
    });
    if (!loaded) {
      throw new AppError('COMMAND_FAILED', `${appId} did not finish loading in ${timeoutMs}ms`, {
        hint: `Retry with open ${appId} --relaunch.`,
      });
    }
  } catch (error) {
    session.page?.close();
    session.page = undefined;
    tunnel.close();
    throw error;
  }
  session.tunnel = tunnel;
  session.appId = appId;
  watchTarget(session, tunnel);
}

// An app that exits leaves the tunnel and the page socket open, and calls to it just time out.
// Only the inspector's target list shows that the page is gone.
function watchTarget(session: TvSession, tunnel: PageTunnel) {
  const { page } = session;
  const port = Number(new URL(tunnel.target.webSocketDebuggerUrl).port);
  const check = async () => {
    if (session.page !== page) return;
    const targets = await listTargets(port).catch(() => undefined);
    if (session.page !== page) return;
    const gone =
      targets &&
      !targets.some((target) => target.webSocketDebuggerUrl === tunnel.target.webSocketDebuggerUrl);
    if (gone) detachPage(session);
    else setTimeout(check, TARGET_WATCH_INTERVAL_MS).unref();
  };
  setTimeout(check, TARGET_WATCH_INTERVAL_MS).unref();
}

function appLog(session: TvSession, appId: string): PageLog {
  const existing = session.logs.get(appId);
  if (existing) return existing;
  const created = createPageLog();
  session.logs.set(appId, created);
  return created;
}

export function detachPage(session: TvSession) {
  session.page?.close();
  session.tunnel?.close();
  session.page = undefined;
  session.tunnel = undefined;
  session.appId = undefined;
}

export function createPageInteractor(session: TvSession, remoteKeys: RemoteKeys): Interactor {
  const { tv, label } = session;
  const unsupported = (what: string) => async (): Promise<never> => {
    throw new AppError('UNSUPPORTED_OPERATION', `${what} is not supported on ${label}`);
  };
  const page = () => {
    if (!session.page) {
      throw new AppError('COMMAND_FAILED', `No ${label} app is attached. Run open <appId> first.`);
    }
    return session.page;
  };
  const mouse = (params: Record<string, unknown>) =>
    page().send('Input.dispatchMouseEvent', params);

  // A single mouseMoved neither wakes a TV pointer cursor nor fires hover; a short wiggle ending
  // on the point does both.
  const hover = async (x: number, y: number) => {
    for (const [dx, dy] of [
      [-9, -6],
      [-6, -4],
      [-3, -2],
      [0, 0],
    ] as const) {
      await mouse({ type: 'mouseMoved', x: x + dx, y: y + dy });
      await sleep(60);
    }
  };

  const press = async (x: number, y: number, holdMs: number) => {
    await hover(x, y);
    const common = { x, y, button: 'left', clickCount: 1 };
    await mouse({ type: 'mousePressed', ...common });
    await sleep(holdMs);
    await mouse({ type: 'mouseReleased', ...common });
  };

  const pressKey = async (button: TvRemoteButton) => {
    const definition = remoteKeys[button];
    if (!definition) {
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        `tv-remote ${button} is not supported on ${label}`,
        { supported: supportedRemoteButtons(remoteKeys) },
      );
    }
    for (const event of keyEvents(definition)) await page().send('Input.dispatchKeyEvent', event);
  };

  const insertText = async (text: string) => {
    await page().send('Input.insertText', { text });
  };

  return {
    async open(app, options) {
      detachPage(session);
      const tunnel = await tv.launch(app, { relaunch: options?.terminateRunningApp === true });
      await attachPage(session, app, tunnel);
      if (session.released) {
        detachPage(session);
        throw new AppError(
          'COMMAND_FAILED',
          `The ${label} TV lease ended while ${app} was opening`,
        );
      }
      return { launchedAppBundleId: app };
    },
    openDevice: unsupported('Opening the device without an app'),
    async close(app) {
      detachPage(session);
      await tv.close(app);
    },
    async tap(x, y) {
      await press(x, y, 100);
    },
    async longPress(x, y, durationMs = 800) {
      await press(x, y, durationMs);
    },
    async hover(x, y) {
      await hover(x, y);
    },
    async focus(x, y) {
      await press(x, y, 100);
    },
    async type(text) {
      await insertText(text);
    },
    async fill(x, y, text) {
      await press(x, y, 100);
      await page().evaluate(SELECT_FOCUSED_CONTENTS);
      await insertText(text);
    },
    // A wheel event has no duration, so durationMs does not apply.
    async scroll(direction, options) {
      const viewport = await page().evaluate<{ width: number; height: number }>(
        '({ width: innerWidth, height: innerHeight })',
      );
      const area = options?.containerRect ?? { x: 0, y: 0, ...viewport };
      const span = direction === 'left' || direction === 'right' ? area.width : area.height;
      const distance = Math.round(options?.pixels ?? span * (options?.amount ?? 0.6));
      const delta: Record<ScrollDirection, { deltaX: number; deltaY: number }> = {
        up: { deltaX: 0, deltaY: -distance },
        down: { deltaX: 0, deltaY: distance },
        left: { deltaX: -distance, deltaY: 0 },
        right: { deltaX: distance, deltaY: 0 },
      };
      await mouse({
        type: 'mouseWheel',
        x: area.x + area.width / 2,
        y: area.y + area.height / 2,
        ...delta[direction],
      });
    },
    async screenshot(outPath) {
      // A hidden page renders no frames, so the capture would never answer.
      if ((await page().evaluate<string>('document.visibilityState')) === 'hidden') {
        throw new AppError(
          'COMMAND_FAILED',
          `${session.appId} is in the background, so there is no frame to capture`,
          { hint: `Bring it back with open ${session.appId}.` },
        );
      }
      const { data } = await page().send<{ data: string }>('Page.captureScreenshot', {
        format: 'png',
      });
      await writeFile(outPath, Buffer.from(data, 'base64'));
      return {};
    },
    async snapshot(options = {}) {
      const capture = await page().evaluate<SnapshotCapture>(SNAPSHOT_EXPRESSION);
      return shapeDesktopSurfaceSnapshot(
        {
          backend: 'android',
          producer: 'cdp-dom',
          nodes: capture.nodes,
          truncated: capture.truncated,
          appName: capture.title,
          appBundleId: session.appId,
        },
        options,
        isInteractiveElement,
      );
    },
    async back() {
      await pressKey('back');
    },
    async tvRemote(button) {
      await pressKey(button);
    },
    setOrientation: unsupported('Orientation'),
    setSetting: unsupported('Settings'),
  };
}
