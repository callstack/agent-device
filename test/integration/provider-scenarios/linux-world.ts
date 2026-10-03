import fs from 'node:fs';
import assert from 'node:assert/strict';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createDeviceInventoryHost } from '../../../src/platform-runtime-host.ts';
import {
  createLocalLinuxToolProvider,
  inventoryModule as linuxInventoryModule,
} from '@agent-device/platform-linux';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { validPng } from './assertions.ts';
import { PROVIDER_SCENARIO_LINUX } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  restoreEnv,
  type ProviderScenarioHarness,
} from './harness.ts';
import type { FlatToolCall } from './providers.ts';

export type LinuxDesktopWorld = {
  daemon: ProviderScenarioHarness;
  localLinuxDevices: DeviceInfo[];
  toolCalls: Array<[string, string[]]>;
  desktopCalls: Array<[string, string]>;
  semanticCalls: FlatToolCall[];
  close: () => Promise<void>;
};

export async function createLinuxDesktopWorld(): Promise<LinuxDesktopWorld> {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  const previousWaylandDisplay = process.env.WAYLAND_DISPLAY;
  const previousAuthHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  const previousPlatform = process.platform;

  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  assert.deepEqual(await discoverLocalLinuxInventory(), []);
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  process.env.XDG_SESSION_TYPE = 'x11';
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;

  const localLinuxDevices = await discoverLocalLinuxInventory();
  const toolCalls: Array<[string, string[]]> = [];
  const desktopCalls: Array<[string, string]> = [];
  const semanticCalls: FlatToolCall[] = [];
  let clipboardText = '';

  const linuxToolProvider = await createLocalLinuxToolProvider({
    whichCommand: async (cmd) =>
      cmd === 'gnome-calculator' || cmd === 'xdotool' || cmd === 'wmctrl',
    runCommand: async (cmd, args) => {
      toolCalls.push([cmd, args]);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    desktop: {
      openTarget: async (target) => {
        desktopCalls.push(['open', target]);
      },
      closeApp: async (app) => {
        desktopCalls.push(['close', app]);
      },
    },
    accessibility: {
      captureTree: async (surface) => {
        semanticCalls.push(['accessibility', surface]);
        return {
          nodes: linuxCalculatorSnapshotNodes(),
          truncated: false,
          surface,
        };
      },
    },
    clipboard: {
      readText: async () => {
        semanticCalls.push(['clipboard', 'read']);
        return clipboardText;
      },
      writeText: async (text) => {
        semanticCalls.push(['clipboard', 'write', text]);
        clipboardText = text;
      },
    },
    screenshot: {
      capture: async (outPath, options) => {
        semanticCalls.push([
          'screenshot',
          outPath,
          String(options?.fullscreen ?? ''),
          String(options?.stabilize ?? ''),
          String(options?.surface ?? ''),
        ]);
        fs.writeFileSync(outPath, validPng());
      },
    },
    input: {
      click: async (x, y, button) => {
        semanticCalls.push(['input', 'click', String(x), String(y), button]);
      },
      doubleClick: async (x, y) => {
        semanticCalls.push(['input', 'double-click', String(x), String(y)]);
      },
      longPress: async (x, y, durationMs) => {
        semanticCalls.push(['input', 'long-press', String(x), String(y), String(durationMs)]);
      },
      drag: async (x1, y1, x2, y2, durationMs) => {
        semanticCalls.push([
          'input',
          'drag',
          String(x1),
          String(y1),
          String(x2),
          String(y2),
          String(durationMs),
        ]);
      },
      scroll: async (direction, options) => {
        semanticCalls.push([
          'input',
          'scroll',
          direction,
          String(options?.amount ?? ''),
          String(options?.pixels ?? ''),
        ]);
      },
      typeText: async (text, options) => {
        semanticCalls.push(['input', 'type', text, String(options?.delayMs ?? 0)]);
      },
      key: async (combo) => {
        semanticCalls.push(['input', 'key', combo]);
      },
    },
  });

  const daemon = await createProviderScenarioHarness({
    linuxToolProvider: () => linuxToolProvider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_LINUX],
  });

  let closed = false;
  return {
    daemon,
    localLinuxDevices,
    toolCalls,
    desktopCalls,
    semanticCalls,
    close: async () => {
      if (closed) return;
      closed = true;
      await daemon.close();
      Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true });
      restoreEnv('XDG_SESSION_TYPE', previousSessionType);
      restoreEnv('WAYLAND_DISPLAY', previousWaylandDisplay);
      restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousAuthHook);
    },
  };
}

const inventoryScope: PlatformRequestScope = Object.freeze({
  signal: new AbortController().signal,
  diagnostics: Object.freeze({ emit: () => {} }),
  progress: Object.freeze({ report: () => {} }),
});

async function discoverLocalLinuxInventory(): Promise<DeviceInfo[]> {
  const source = await linuxInventoryModule.loadInventory(createDeviceInventoryHost());
  return [...(await source.discover({ platform: 'linux' }, inventoryScope))];
}

function linuxCalculatorSnapshotNodes(): Array<{
  index: number;
  role: string;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  hittable: boolean;
  depth: number;
  parentIndex?: number;
}> {
  return [
    {
      index: 0,
      role: 'frame',
      label: 'Calculator',
      rect: { x: 0, y: 0, width: 320, height: 480 },
      enabled: true,
      hittable: true,
      depth: 0,
    },
    {
      index: 1,
      role: 'push button',
      label: '5',
      rect: { x: 40, y: 80, width: 40, height: 40 },
      enabled: true,
      hittable: true,
      depth: 1,
      parentIndex: 0,
    },
    {
      index: 2,
      role: 'push button',
      label: 'Clear',
      rect: { x: 90, y: 80, width: 70, height: 40 },
      enabled: true,
      hittable: true,
      depth: 1,
      parentIndex: 0,
    },
  ];
}
