import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { assertCommandCall, assertPngFile } from './assertions.ts';
import { PROVIDER_SCENARIO_LINUX } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';
import { createLinuxDesktopWorld } from './linux-world.ts';
import { runProviderScenario } from './scenario.ts';

/**
 * The Linux desktop flow through the installed plugin, with a scripted desktop behind it.
 *
 * The scenario's evidence is what the family asked its host to run: each intent becomes the desktop
 * tool argv the X11 session would see. Every step's response is asserted as before; the host record
 * proves the request reached the desktop through the plugin's own route rather than a stand-in.
 */
test('Provider-backed integration Linux desktop flow drives the desktop tools through its host', async () => {
  await withProviderScenarioResource(
    createLinuxDesktopWorld,
    async ({ commands, daemon, launches, localLinuxDevices, probedPaths, toolCalls }) => {
      const screenshotPath = createProviderScenarioTempPath(
        'agent-device-provider-scenario-linux',
        'png',
      );
      assert.equal(localLinuxDevices[0]?.platform, 'linux');
      assert.equal(localLinuxDevices[0]?.target, 'desktop');

      try {
        const devices = await daemon.client().devices.list({ platform: 'linux' });
        assert.equal(devices.length, 1);
        assert.equal(devices[0]?.platform, 'linux');
        assert.equal(devices[0]?.id, PROVIDER_SCENARIO_LINUX.id);
        assert.equal(devices[0]?.target, 'desktop');

        await runProviderScenario(daemon, [
          {
            name: 'open calculator app',
            command: 'open',
            positionals: ['gnome-calculator'],
            flags: { platform: 'linux' },
          },
          {
            name: 'capture interactive snapshot',
            command: 'snapshot',
            flags: { snapshotInteractiveOnly: true },
            assert: (snapshot) => {
              const digitFive = snapshot.json?.result?.data?.nodes?.find(
                (node: { label?: string }) => node.label === '5',
              );
              assert.equal(digitFive?.ref, 'e2', JSON.stringify(snapshot.json));
            },
          },
          {
            name: 'scope snapshot to calculator frame with depth limit',
            command: 'snapshot',
            flags: { snapshotScope: '@e1', snapshotDepth: 0 },
            assert: (snapshot) => {
              assert.deepEqual(
                snapshot.json?.result?.data?.nodes?.map((node: { label?: string }) => node.label),
                ['Calculator'],
              );
            },
          },
          {
            name: 'scope snapshot to ref from previous broad snapshot source',
            command: 'snapshot',
            flags: { snapshotScope: '@e3' },
            assert: (snapshot) => {
              assert.deepEqual(
                snapshot.json?.result?.data?.nodes?.map((node: { label?: string }) => node.label),
                ['Clear'],
              );
            },
          },
          {
            name: 'refresh broad interactive snapshot after scoped output',
            command: 'snapshot',
            flags: { snapshotInteractiveOnly: true },
          },
          {
            name: 'press snapshot ref',
            command: 'press',
            positionals: ['@e2'],
            expectData: { x: 60, y: 100 },
          },
          {
            name: 'read snapshot ref text through Linux accessibility',
            command: 'get',
            positionals: ['text', '@e2'],
            expectData: { text: '5' },
          },
          {
            name: 'press coordinates',
            command: 'press',
            positionals: ['42', '84'],
            expectData: { x: 42, y: 84 },
          },
          {
            name: 'secondary click coordinates',
            command: 'click',
            positionals: ['42', '84'],
            flags: { clickButton: 'secondary' },
            expectData: { button: 'secondary' },
          },
          {
            name: 'middle click coordinates',
            command: 'click',
            positionals: ['42', '84'],
            flags: { clickButton: 'middle' },
            expectData: { button: 'middle' },
          },
          {
            name: 'double tap coordinates',
            command: 'press',
            positionals: ['42', '84'],
            flags: { doubleTap: true },
            expectData: { doubleTap: true },
          },
          {
            name: 'focus coordinates',
            command: 'focus',
            positionals: ['42', '84'],
            expectData: { x: 42, y: 84 },
          },
          {
            name: 'long press coordinates',
            command: 'longpress',
            positionals: ['42', '84', '1'],
          },
          {
            name: 'pan coordinates',
            command: 'gesture',
            input: {
              kind: 'pan',
              origin: { x: 10, y: 20 },
              delta: { x: 20, y: 20 },
              durationMs: 16,
            },
            expectData: {
              kind: 'pan',
              durationMs: 16,
              pointerCount: 1,
              from: { x: 10, y: 20 },
              to: { x: 30, y: 40 },
            },
          },
          {
            // ADR 0014: the earlier ref press (and the coordinate gestures)
            // expired the frame, so re-observe before the next ref mutation.
            name: 're-observe before the next ref mutation',
            command: 'snapshot',
            flags: { snapshotInteractiveOnly: true },
          },
          {
            name: 'fill snapshot ref',
            command: 'fill',
            positionals: ['@e2', 'Seven'],
            flags: { delayMs: 1 },
            expectData: { text: 'Seven' },
          },
          {
            name: 'fill coordinates',
            command: 'fill',
            positionals: ['42', '84', 'Eight'],
            flags: { delayMs: 1 },
            expectData: { x: 42, y: 84, text: 'Eight' },
          },
          {
            name: 'scroll by pixels',
            command: 'scroll',
            positionals: ['down'],
            flags: { pixels: 45 },
            expectData: { pixels: 45 },
          },
          {
            name: 'scroll up',
            command: 'scroll',
            positionals: ['up'],
            expectData: { direction: 'up' },
          },
          {
            name: 'type text',
            command: 'type',
            positionals: ['5'],
            expectData: { text: '5' },
          },
          {
            name: 'write clipboard',
            command: 'clipboard',
            positionals: ['write', 'linux otp 314159'],
            expectData: { textLength: 16 },
          },
          {
            name: 'read clipboard',
            command: 'clipboard',
            positionals: ['read'],
            expectData: { text: 'linux otp 314159' },
          },
          {
            name: 'capture screenshot artifact',
            command: 'screenshot',
            positionals: [screenshotPath],
            flags: {
              screenshotFullscreen: true,
              screenshotNoStabilize: true,
            },
            expectData: { path: screenshotPath },
            assert: () => {
              assertPngFile(screenshotPath);
            },
          },
          { name: 'navigate back', command: 'back' },
          { name: 'show desktop', command: 'home' },
        ]);

        const close = await daemon.callCommand('close', ['gnome-calculator']);
        assert.equal(close.statusCode, 200, JSON.stringify(close.json));

        // The app the scenario opened and closed, as the desktop saw it: an app that outlives the
        // request is launched detached, and a window is closed by name.
        assert.deepEqual(launches, [['gnome-calculator']]);
        assertCommandCall(toolCalls, ['wmctrl', '-c', 'gnome-calculator']);

        // Every capture reads the AT-SPI tree through the helper the package ships, for the surface
        // the request named. The full argv carries the helper path and the traversal limits, so the
        // surface is the part this scenario owns.
        assert.deepEqual([...new Set(toolCalls.flatMap((call) => surfaceAsks(call)))].sort(), [
          'frontmost-app',
        ]);

        // The helper is located through the host's own presence check before it runs, and the path
        // that check settles on is the one the capture executes.
        const helper = probedPaths.find((probed) => probed.endsWith('atspi-dump.py'));
        assert.ok(helper, JSON.stringify(probedPaths));
        assert.ok(
          toolCalls.some((call) => call[0] === 'python3' && call[1] === helper),
          JSON.stringify(toolCalls.filter((call) => call[0] === 'python3')),
        );

        // The clipboard round-trips through the X11 selection tool: text in on stdin, read back.
        const clipboardWrite = commands.find(
          (call) => call.command === 'xclip' && call.stdin !== undefined,
        );
        assert.deepEqual(clipboardWrite?.args, ['-selection', 'clipboard']);
        assert.equal(clipboardWrite?.stdin, 'linux otp 314159');
        assertCommandCall(toolCalls, ['xclip', '-selection', 'clipboard', '-o']);

        // Input synthesis is xdotool on this X11 session. The pointer is moved before every click
        // because the scripted desktop never reports it as already being there.
        assertCommandCall(toolCalls, ['xdotool', 'mousemove', '--sync', '60', '100']);
        assertCommandCall(toolCalls, ['xdotool', 'mousemove', '--sync', '42', '84']);
        assertCommandCall(toolCalls, ['xdotool', 'click', '1']);
        assertCommandCall(toolCalls, ['xdotool', 'click', '3']);
        assertCommandCall(toolCalls, ['xdotool', 'click', '2']);
        assertCommandCall(toolCalls, ['xdotool', 'click', '--repeat', '2', '1']);
        assertCommandCall(toolCalls, ['xdotool', 'mousedown', '1']);
        assertCommandCall(toolCalls, ['xdotool', 'mouseup', '1']);
        assertCommandCall(toolCalls, ['xdotool', 'mousemove', '--sync', '30', '40']);
        // `fill` focuses the field, selects the old value, then types the replacement at the
        // requested delay. Both fills use their own text; the ref fill moves to the ref's centre.
        assertCommandCall(toolCalls, ['xdotool', 'key', '--clearmodifiers', 'ctrl+a']);
        assertCommandCall(toolCalls, [
          'xdotool',
          'type',
          '--delay',
          '1',
          '--clearmodifiers',
          '--',
          'Seven',
        ]);
        assertCommandCall(toolCalls, [
          'xdotool',
          'type',
          '--delay',
          '1',
          '--clearmodifiers',
          '--',
          'Eight',
        ]);
        assertCommandCall(toolCalls, ['xdotool', 'type', '--clearmodifiers', '--', '5']);
        // `--pixels 45` is three ~15px wheel clicks, dispatched as one paced batch; the plain scroll
        // keeps the default five.
        assertCommandCall(toolCalls, ['xdotool', 'click', '--repeat', '3', '5']);
        assertCommandCall(toolCalls, ['xdotool', 'click', '--repeat', '5', '4']);
        // The system buttons are their key combinations.
        assertCommandCall(toolCalls, ['xdotool', 'key', '--clearmodifiers', 'alt+Left']);
        assertCommandCall(toolCalls, ['xdotool', 'key', '--clearmodifiers', 'super+d']);
        // The capture tool writes the destination the request named; the PNG check above is what
        // proves the artifact, since the tool's own argv carries no full-screen or stabilization flag.
        assertCommandCall(toolCalls, ['scrot', screenshotPath]);
      } finally {
        fs.rmSync(screenshotPath, { force: true });
      }
    },
  );
});

/** The `--surface` values one host command names, which only the AT-SPI helper call carries. */
function surfaceAsks(call: readonly string[]): readonly string[] {
  const surfaceAt = call.indexOf('--surface');
  return surfaceAt >= 0 && call[surfaceAt + 1] !== undefined ? [call[surfaceAt + 1]!] : [];
}
