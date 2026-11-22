import fs from 'node:fs';
import assert from 'node:assert/strict';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import { createDeviceInventoryHost } from '../../../src/platform-runtime-host.ts';
import { linuxSelectionFixture } from '../../../src/platform-runtime-linux-provider.fixtures.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { validPng } from './assertions.ts';
import { PROVIDER_SCENARIO_LINUX } from './fixtures.ts';
import {
  createProviderScenarioHarness,
  restoreEnv,
  type ProviderScenarioHarness,
} from './harness.ts';
import {
  createLinuxScenarioHost,
  type LinuxScenarioAnswer,
  type LinuxScenarioCommand,
  type LinuxScenarioHost,
} from './linux-host.fixtures.ts';

/** The desktop tools the scripted X11 session has installed. */
const SCRIPTED_X11_TOOLS = ['xdotool', 'wmctrl', 'gnome-calculator', 'xclip', 'scrot', 'python3'];

export type LinuxDesktopWorld = {
  daemon: ProviderScenarioHarness;
  localLinuxDevices: DeviceInfo[];
  /** Every host command the family ran, with its argv and stdin. */
  commands: LinuxScenarioHost['commands'];
  /** Every host command the family ran, as `[executable, ...argv]`. */
  toolCalls: Array<[string, ...string[]]>;
  /** Every detached launch the family asked the host for, as `[executable, ...argv]`. */
  launches: Array<[string, ...string[]]>;
  /** Every path the family asked the host to check before using it. */
  probedPaths: string[];
  close: () => Promise<void>;
};

/**
 * The Linux family served by the installed plugin, with one scripted desktop in front of it.
 *
 * The family runs every desktop intent through the `PlatformHost` its plugin was set up with, so the
 * scenario scripts that host: which desktop tools exist, what each command answers, and what the
 * session's clipboard holds. The real inventory, runtime, interactor and tool selection answer for
 * the request, so the scenario proves the family's own route to the desktop, and its recorded argv is
 * the evidence.
 */
export async function createLinuxDesktopWorld(): Promise<LinuxDesktopWorld> {
  const previousAuthHook = process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  delete process.env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  const previousPlatform = process.platform;

  // The plugin's inventory reports the local desktop only for a Linux host, so the scenario proves
  // both answers by naming the host it runs on.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  assert.deepEqual(await discoverLocalLinuxInventory(), []);
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const localLinuxDevices = await discoverLocalLinuxInventory();

  // The desktop's own state: the text its selection holds, which the clipboard tools read back.
  const desktop = { clipboard: '' };
  const host = createLinuxScenarioHost({
    tools: SCRIPTED_X11_TOOLS,
    env: { PATH: '/usr/bin', XDG_SESSION_TYPE: 'x11' },
    respond: (command) => answerScriptedDesktop(command, desktop),
  });

  const daemon = await createProviderScenarioHarness({
    linuxPlatformHost: host.host,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_LINUX],
  });

  let closed = false;
  return {
    daemon,
    localLinuxDevices,
    commands: host.commands,
    toolCalls: host.toolCalls,
    launches: host.launches,
    probedPaths: host.probedPaths,
    close: async () => {
      if (closed) return;
      closed = true;
      await daemon.close();
      await host.dispose();
      Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true });
      restoreEnv('AGENT_DEVICE_HTTP_AUTH_HOOK', previousAuthHook);
    },
  };
}

/**
 * Answers one command as the scripted X11 desktop would: the AT-SPI helper prints the calculator's
 * tree, the clipboard tools read and write the session selection, and the capture tool writes a PNG.
 * Every other command is a synthesized input event or a window action, which succeed silently.
 */
function answerScriptedDesktop(
  command: LinuxScenarioCommand,
  desktop: { clipboard: string },
): LinuxScenarioAnswer {
  switch (command.command) {
    case 'python3':
      return { stdout: scriptedAtspiTree(command.args), exitCode: 0 };
    case 'xclip':
      // The tool's own selection model: `-o` reads it, and text on stdin replaces it.
      if (command.args.includes('-o')) return { stdout: desktop.clipboard, exitCode: 0 };
      desktop.clipboard = command.stdin ?? '';
      return { stdout: '', exitCode: 0 };
    case 'scrot':
      fs.writeFileSync(scriptedCapturePath(command), scriptedPng());
      return { stdout: '', exitCode: 0 };
    default:
      return { stdout: '', exitCode: 0 };
  }
}

/** The capture tool's output path: its last non-flag argument. */
function scriptedCapturePath(command: LinuxScenarioCommand): string {
  const destination = [...command.args].reverse().find((arg) => !arg.startsWith('-'));
  assert.ok(destination, 'the scripted capture tool was called without a destination');
  return destination;
}

/** A capture the request can publish: the same image every other scenario's fake desktop writes. */
function scriptedPng(): Buffer {
  return validPng();
}

/**
 * The calculator window the AT-SPI helper reports: its frame and two buttons, in the helper's own
 * vocabulary. `--surface` tells the helper — and therefore the scenario — which surface was asked for.
 */
function scriptedAtspiTree(args: readonly string[]): string {
  const surfaceAt = args.indexOf('--surface');
  const surface = surfaceAt >= 0 ? args[surfaceAt + 1] : undefined;
  return JSON.stringify({
    nodes: [
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
    ],
    truncated: false,
    surface,
  });
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
