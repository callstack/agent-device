import { expect, test, vi } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../../daemon/types.ts';
import type { SnapshotState } from '../../../kernel/snapshot.ts';
import {
  invokeMaestroSwipeScreen,
  invokeMaestroSwipeOn,
  invokeMaestroTapOn,
  invokeMaestroTapPointPercent,
} from '../runtime-interactions.ts';
import { consumeMaestroRecoverableInteraction } from '../runtime-support.ts';

test('invokeMaestroTapOn resolves mutating taps from the current snapshot', async () => {
  const selector =
    'label="Article by Gandalf" || text="Article by Gandalf" || id="Article by Gandalf"';

  const { response, clicks, clickFlags, snapshots } = await runTapOn(selector, () =>
    currentBreadcrumbSnapshot(),
  );

  expect(response.ok).toBe(true);
  expect(snapshots).toBe(1);
  expect(clicks).toEqual([['86', '89']]);
  expect(clickFlags[0]?.postGestureStabilization).toBe(true);
  expect(clickFlags[0]?.interactionOutcome).toBeUndefined();
});

test('invokeMaestroTapOn uses raw snapshots for target resolution', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroTapOn({
    baseReq: {
      token: 'test',
      session: 'article',
      flags: { platform: 'ios' },
    },
    positionals: [
      'label="Article by Gandalf" || text="Article by Gandalf" || id="Article by Gandalf"',
    ],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: currentBreadcrumbSnapshot() };
      }
      if (req.command === 'click') return { ok: true, data: {} };
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(snapshotFlags).toHaveLength(1);
  expect(snapshotFlags[0]?.noRecord).toBe(true);
  expect(snapshotFlags[0]?.snapshotInteractiveOnly).toBeUndefined();
  expect(snapshotFlags[0]?.snapshotRaw).toBe(true);
  expect(snapshotFlags[0]?.snapshotForceFull).toBeUndefined();
});

test('invokeMaestroTapOn resolves drawer targets from raw snapshots', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const clicks: string[][] = [];
  const response = await invokeMaestroTapOn({
    baseReq: {
      token: 'test',
      session: 'drawer',
      flags: { platform: 'ios' },
    },
    positionals: ['label="Feed" || text="Feed" || id="Feed"'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return {
          ok: true,
          data: req.flags?.snapshotRaw === true ? drawerRawSnapshot() : pagesOnlySnapshot(),
        };
      }
      if (req.command === 'click') {
        clicks.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(snapshotFlags.map((flags) => flags?.snapshotRaw)).toEqual([true]);
  expect(clicks).toEqual([['201', '202']]);
});

test('invokeMaestroTapOn retries raw target snapshots without interactive fallback', async () => {
  vi.useFakeTimers();
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const responsePromise = invokeMaestroTapOn({
    baseReq: {
      token: 'test',
      session: 'bottom-tabs',
      flags: { platform: 'ios' },
    },
    positionals: ['id="article"'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: truncatedContentSnapshot() };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  try {
    await vi.advanceTimersByTimeAsync(30_000);
    const response = await responsePromise;

    expect(response.ok).toBe(false);
    expect(snapshotFlags.length).toBeGreaterThan(1);
    expect(snapshotFlags.some((flags) => flags?.snapshotInteractiveOnly === true)).toBe(false);
    expect(snapshotFlags.every((flags) => flags?.snapshotRaw === true)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('invokeMaestroSwipeOn does not use interactive fallback for truncated regular snapshot misses', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroSwipeOn({
    baseReq: {
      token: 'test',
      session: 'bottom-tabs',
      flags: { platform: 'ios' },
    },
    positionals: ['id="article"', 'left', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: truncatedContentSnapshot() };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(false);
  expect(snapshotFlags).toHaveLength(1);
  expect(snapshotFlags[0]?.snapshotInteractiveOnly).toBeUndefined();
});

test('invokeMaestroSwipeOn does not use interactive fallback for complete regular snapshot misses', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroSwipeOn({
    baseReq: {
      token: 'test',
      session: 'complete-miss',
      flags: { platform: 'ios' },
    },
    positionals: ['id="article"', 'left', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return { ok: true, data: { ...truncatedContentSnapshot(), truncated: false } };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(false);
  expect(snapshotFlags).toHaveLength(1);
  expect(snapshotFlags[0]?.snapshotInteractiveOnly).toBeUndefined();
});

test('invokeMaestroTapOn resolves visible Android non-interactive text from a regular snapshot', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const clicks: string[][] = [];
  const response = await invokeMaestroTapOn({
    baseReq: {
      token: 'test',
      session: 'android-header',
      flags: { platform: 'android' },
    },
    positionals: ['label="Albums" || text="Albums" || id="Albums"'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return {
          ok: true,
          data: {
            nodes: [
              appNode(),
              windowNode(),
              {
                index: 56,
                ref: 'e56',
                type: 'android.view.View',
                label: 'Albums',
                value: 'Albums',
                depth: 20,
                parentIndex: 1,
                rect: { x: 154, y: 194, width: 188, height: 74 },
                visibleToUser: true,
                enabled: true,
              },
            ],
          },
        };
      }
      if (req.command === 'click') {
        clicks.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(snapshotFlags).toHaveLength(1);
  expect(snapshotFlags[0]?.snapshotInteractiveOnly).toBeUndefined();
  expect(snapshotFlags[0]?.snapshotRaw).toBe(true);
  expect(clicks).toEqual([['248', '231']]);
});

test('invokeMaestroTapOn taps resolved iOS buttons by coordinates', async () => {
  const { response, clicks } = await runTapOn(
    'label="Pop to top" || text="Pop to top" || id="Pop to top"',
    () => buttonSnapshot('Pop to top'),
  );

  expect(response.ok).toBe(true);
  expect(clicks).toEqual([['201', '149']]);
});

test('invokeMaestroTapOn clicks normal Close/Dismiss buttons when no React Native overlay is present', async () => {
  const { response, commands } = await runTapOn(
    'label="Dismiss" || text="Dismiss" || id="Dismiss"',
    () => buttonSnapshot('Dismiss'),
  );

  expect(response.ok).toBe(true);
  expect(commands).toEqual(['snapshot', 'click']);
});

test('invokeMaestroTapOn clicks explicit React Native overlay controls directly', async () => {
  const { response, commands, clicks } = await runTapOn(
    'label="Dismiss" || text="Dismiss" || id="Dismiss"',
    () => overlayDismissButtonSnapshot(),
  );

  expect(response.ok).toBe(true);
  expect(commands).toEqual(['snapshot', 'click']);
  expect(clicks).toEqual([['355', '30']]);
});

test('invokeMaestroSwipeScreen maps Android horizontal directional swipes to Maestro content lane', async () => {
  const swipes: string[][] = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'pager',
      flags: { platform: 'android' },
    },
    positionals: ['direction', 'left', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') return { ok: true, data: fullScreenSnapshot(400, 800) };
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['340', '520', '60', '520', '300']]);
});

test('invokeMaestroSwipeScreen mirrors Android horizontal directional content lane swipes', async () => {
  const swipes: string[][] = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'pager',
      flags: { platform: 'android' },
    },
    positionals: ['direction', 'right', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') return { ok: true, data: fullScreenSnapshot(400, 800) };
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['60', '520', '340', '520', '300']]);
});

test('invokeMaestroSwipeScreen maps Android vertical down swipes to the paced swipe path', async () => {
  const scope = { values: {} };
  const swipes: string[][] = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'pager',
      flags: { platform: 'android' },
    },
    scope,
    positionals: ['direction', 'down', '100'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') return { ok: true, data: fullScreenSnapshot(400, 800) };
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['200', '160', '200', '640', '100']]);
  expect(consumeMaestroRecoverableInteraction(scope)).toEqual({
    kind: 'swipe',
    positionals: ['200', '160', '200', '640', '100'],
  });
});

test('invokeMaestroSwipeScreen maps Android vertical up swipes to the paced swipe path', async () => {
  const swipes: string[][] = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'pager',
      flags: { platform: 'android' },
    },
    positionals: ['direction', 'up'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') return { ok: true, data: fullScreenSnapshot(400, 800) };
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['200', '640', '200', '160']]);
});

test('invokeMaestroSwipeOn resolves visible non-interactive text from a regular snapshot', async () => {
  const snapshotFlags: Array<DaemonRequest['flags']> = [];
  const swipes: string[][] = [];
  const swipeFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroSwipeOn({
    baseReq: {
      token: 'test',
      session: 'android-carousel',
      flags: { platform: 'android', postGestureStabilization: true },
    },
    positionals: ['label="Gallery" || text="Gallery" || id="Gallery"', 'left', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        snapshotFlags.push(req.flags);
        return {
          ok: true,
          data: {
            nodes: [
              appNode(),
              windowNode(),
              {
                index: 4,
                ref: 'e4',
                type: 'android.view.View',
                label: 'Gallery',
                value: 'Gallery',
                depth: 2,
                parentIndex: 1,
                rect: { x: 100, y: 200, width: 200, height: 100 },
                visibleToUser: true,
                enabled: true,
              },
            ],
          },
        };
      }
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        swipeFlags.push(req.flags);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(snapshotFlags).toHaveLength(1);
  expect(snapshotFlags[0]?.snapshotInteractiveOnly).toBeUndefined();
  expect(snapshotFlags[0]?.snapshotRaw).toBe(true);
  expect(swipes).toEqual([['200', '250', '8', '250', '300']]);
  expect(swipeFlags[0]?.postGestureStabilization).toBe(true);
});

test('invokeMaestroSwipeScreen preserves vertical percentage endpoints', async () => {
  const swipes: string[][] = [];
  const swipeFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'article',
      flags: { platform: 'ios' },
    },
    positionals: ['percent', '50', '75', '50', '35', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        return { ok: true, data: fullScreenSnapshot(400, 800) };
      }
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        swipeFlags.push(req.flags);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['200', '600', '200', '280', '300']]);
  expect(swipeFlags[0]?.postGestureStabilization).toBeUndefined();
});

test('invokeMaestroSwipeScreen keeps iOS horizontal percentage swipes away from screen edges', async () => {
  const swipes: string[][] = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'ios-pager',
      flags: { platform: 'ios' },
    },
    positionals: ['percent', '10', '50', '90', '50', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        return { ok: true, data: fullScreenSnapshot(400, 800) };
      }
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['60', '400', '340', '400', '300']]);
});

test('invokeMaestroSwipeScreen maps broad Android horizontal percentage swipes to the content lane', async () => {
  const swipes: string[][] = [];
  const response = await invokeMaestroSwipeScreen({
    baseReq: {
      token: 'test',
      session: 'pager',
      flags: { platform: 'android' },
    },
    positionals: ['percent', '90', '50', '10', '50', '300'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        return { ok: true, data: fullScreenSnapshot(390, 600) };
      }
      if (req.command === 'swipe') {
        swipes.push(req.positionals ?? []);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(swipes).toEqual([['351', '390', '39', '390', '300']]);
});

test('invokeMaestroTapPointPercent shares percentage point geometry without clamping', async () => {
  const clicks: string[][] = [];
  const clickFlags: Array<DaemonRequest['flags']> = [];
  const response = await invokeMaestroTapPointPercent({
    baseReq: {
      token: 'test',
      session: 'article',
      flags: { platform: 'ios' },
    },
    positionals: ['125', '-10'],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      if (req.command === 'snapshot') {
        return { ok: true, data: fullScreenSnapshot(400, 800) };
      }
      if (req.command === 'click') {
        clicks.push(req.positionals ?? []);
        clickFlags.push(req.flags);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });

  expect(response.ok).toBe(true);
  expect(clicks).toEqual([['500', '-80']]);
  expect(clickFlags[0]?.postGestureStabilization).toBe(true);
});

function currentBreadcrumbSnapshot(): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      appNode(),
      windowNode(),
      {
        index: 2,
        ref: 'e3',
        type: 'ScrollView',
        label: 'Article by Gandalf',
        depth: 4,
        parentIndex: 1,
        rect: { x: 0, y: 58.33333333333333, width: 402, height: 58.33333333333333 },
      },
      {
        index: 3,
        ref: 'e4',
        type: 'Cell',
        label: 'Article by Gandalf',
        depth: 5,
        parentIndex: 2,
        rect: { x: 8, y: 65.33333587646484, width: 155, height: 48 },
      },
    ],
  };
}

function pagesOnlySnapshot(): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      appNode(),
      windowNode(),
      {
        index: 2,
        ref: 'e3',
        type: 'StaticText',
        label: 'Pages',
        depth: 4,
        parentIndex: 1,
        rect: {
          x: 176.6666717529297,
          y: 75.66666603088379,
          width: 48.666656494140625,
          height: 20.333335876464844,
        },
      },
    ],
  };
}

function drawerRawSnapshot(): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      appNode(),
      windowNode(),
      {
        index: 2,
        ref: 'e3',
        type: 'StaticText',
        label: 'Pages',
        depth: 4,
        parentIndex: 1,
        rect: {
          x: 176.6666717529297,
          y: 75.66666603088379,
          width: 48.666656494140625,
          height: 20.333335876464844,
        },
      },
      {
        index: 3,
        ref: 'e4',
        type: 'ScrollView',
        label: 'Article',
        depth: 4,
        parentIndex: 1,
        rect: { x: 0, y: 116.66666412353516, width: 402, height: 757.3333333333333 },
      },
      {
        index: 4,
        ref: 'e5',
        type: 'Button',
        label: 'Article',
        depth: 5,
        parentIndex: 3,
        rect: { x: 12, y: 120.66666412353516, width: 378, height: 54.00000762939453 },
      },
      {
        index: 5,
        ref: 'e6',
        type: 'Button',
        label: 'Feed',
        depth: 5,
        parentIndex: 3,
        rect: { x: 12, y: 174.66666412353516, width: 378, height: 54 },
      },
      {
        index: 6,
        ref: 'e7',
        type: 'Button',
        label: 'Albums',
        depth: 5,
        parentIndex: 3,
        rect: { x: 12, y: 228.66666412353516, width: 378, height: 53.99998474121094 },
      },
      {
        index: 7,
        ref: 'e8',
        type: 'StaticText',
        label: 'Feed',
        depth: 4,
        parentIndex: 1,
        rect: {
          x: 181.3333282470703,
          y: 75.66666603088379,
          width: 39.333343505859375,
          height: 20.333335876464844,
        },
      },
    ],
  };
}

async function runTapOn(
  selector: string,
  readSnapshot: (snapshotIndex: number) => SnapshotState,
): Promise<{
  response: DaemonResponse;
  commands: string[];
  clicks: string[][];
  clickFlags: Array<DaemonRequest['flags']>;
  snapshots: number;
}> {
  const commands: string[] = [];
  const clicks: string[][] = [];
  const clickFlags: Array<DaemonRequest['flags']> = [];
  let snapshots = 0;
  const response = await invokeMaestroTapOn({
    baseReq: {
      token: 'test',
      session: 'nav',
      flags: { platform: 'ios' },
    },
    positionals: [selector],
    invoke: async (req: DaemonRequest): Promise<DaemonResponse> => {
      commands.push(req.command);
      if (req.command === 'snapshot') {
        snapshots += 1;
        return { ok: true, data: readSnapshot(snapshots) };
      }
      if (req.command === 'click') {
        clicks.push(req.positionals ?? []);
        clickFlags.push(req.flags);
        return { ok: true, data: {} };
      }
      return { ok: false, error: { code: 'UNEXPECTED_COMMAND', message: req.command } };
    },
  });
  return { response, commands, clicks, clickFlags, snapshots };
}

function fullScreenSnapshot(width: number, height: number): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      {
        index: 0,
        ref: 'e1',
        type: 'Application',
        label: 'Android Test App',
        depth: 0,
        rect: { x: 0, y: 0, width, height },
      },
      {
        index: 1,
        ref: 'e2',
        type: 'Window',
        depth: 1,
        parentIndex: 0,
        rect: { x: 0, y: 0, width, height },
      },
    ],
  };
}

function buttonSnapshot(label: string): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      appNode(),
      windowNode(),
      {
        index: 2,
        ref: 'e3',
        type: 'Button',
        label,
        depth: 4,
        parentIndex: 1,
        rect: { x: 142, y: 128.66666412353516, width: 118, height: 40 },
      },
    ],
  };
}

function overlayDismissButtonSnapshot(): SnapshotState {
  return {
    createdAt: Date.now(),
    nodes: [
      appNode(),
      windowNode(),
      {
        index: 10,
        ref: 'e10',
        type: 'StaticText',
        label: 'Runtime Error',
        depth: 2,
        parentIndex: 1,
        rect: { x: 0, y: 0, width: 402, height: 40 },
      },
      {
        index: 11,
        ref: 'e11',
        type: 'Button',
        label: 'Dismiss',
        depth: 2,
        parentIndex: 1,
        rect: { x: 320, y: 12, width: 70, height: 36 },
      },
      {
        index: 12,
        ref: 'e12',
        type: 'StaticText',
        label: 'Call Stack',
        depth: 2,
        parentIndex: 1,
        rect: { x: 0, y: 52, width: 402, height: 40 },
      },
    ],
  };
}

function truncatedContentSnapshot(): SnapshotState {
  return {
    createdAt: Date.now(),
    truncated: true,
    nodes: [
      appNode(),
      windowNode(),
      {
        index: 2,
        ref: 'e3',
        type: 'ScrollView',
        label: 'Contacts',
        depth: 2,
        parentIndex: 1,
        rect: { x: 0, y: 92, width: 402, height: 699 },
      },
      {
        index: 3,
        ref: 'e4',
        type: 'StaticText',
        label: 'Marissa Castillo',
        depth: 3,
        parentIndex: 2,
        rect: { x: 16, y: 128, width: 160, height: 22 },
      },
    ],
  };
}

function appNode(): SnapshotState['nodes'][number] {
  return {
    index: 0,
    ref: 'e1',
    type: 'Application',
    label: 'React Navigation Example',
    depth: 0,
    rect: { x: 0, y: 0, width: 402, height: 874 },
  };
}

function windowNode(): SnapshotState['nodes'][number] {
  return {
    index: 1,
    ref: 'e2',
    type: 'Window',
    depth: 1,
    parentIndex: 0,
    rect: { x: 0, y: 0, width: 402, height: 874 },
  };
}
