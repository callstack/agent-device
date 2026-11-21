import fs from 'node:fs';
import assert from 'node:assert/strict';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createDeviceInventoryHost } from '../../../src/platform-runtime-host.ts';
import { linuxSelectionFixture } from '../../../src/platform-runtime-linux-provider.fixtures.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
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

/**
 * The Linux family served by the installed plugin, with one scripted desktop in front of it.
 *
 * The scenario hands the daemon a Linux tool provider, so every request runs against the provider it
 * scoped rather than against a desktop. The provider is the contract's vocabulary, so this file names
 * no Linux implementation: the plugin resolves it through its own selection, which is what registers
 * the family's runtime and interactor here.
 */
export async function createLinuxDesktopWorld(): Promise<LinuxDesktopWorld> {
  const previousSessionType = process.env.XDG_SESSION_TYPE;
  const previousWaylandDisplay = process.env.WAYLAND_DISPLAY;
  const previousAuthHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  const previousPlatform = process.platform;

  // The plugin's inventory reports the local desktop only for a Linux host, so the scenario proves
  // both answers by naming the host it runs on.
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

  const linuxToolProvider: LinuxToolProvider = {
    // The display decision the scripted desktop stands for; the family selects its tools by it.
    display: { detectDisplayServer: () => 'x11' },
    runCommand: async (cmd, args) => {
      toolCalls.push([cmd, [...args]]);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    whichCommand: async (cmd) =>
      cmd === 'gnome-calculator' || cmd === 'xdotool' || cmd === 'wmctrl',
    // The scripted desktop owns app launches, so the detached launcher is never reached.
    launchDetached: (cmd) => {
      throw new Error(`the Linux world launches apps through its desktop: ${cmd}`);
    },
    // Interaction pacing belongs to the scripted desktop too: the scenario asserts the intent, not
    // the wall clock.
    sleep: async () => {},
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
  };

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

/** Discovery through the installed plugin: the family reports its desktop from the host facts it is given. */
async function discoverLocalLinuxInventory(): Promise<DeviceInfo[]> {
  const registration = linuxSelectionFixture({ env: { ...process.env }, cwd: process.cwd() }).get();
  const source = await registration.inventoryModule.loadInventory(
    createDeviceInventoryHost({ env: { ...process.env }, cwd: process.cwd() }),
  );
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
