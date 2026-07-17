import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { assertFlatToolCall, assertPngFile } from './assertions.ts';
import { PROVIDER_SCENARIO_LINUX } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';
import { createLinuxDesktopWorld } from './linux-world.ts';
import { runProviderScenario } from './scenario.ts';

test('Provider-backed integration Linux desktop flow uses semantic desktop and input providers', async () => {
  await withProviderScenarioResource(
    createLinuxDesktopWorld,
    async ({ daemon, desktopCalls, localLinuxDevices, semanticCalls, toolCalls }) => {
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

        const actions = daemon.session()?.actions ?? [];
        assert.ok(
          actions.some(
            (action) =>
              action.command === 'fill' &&
              action.positionals.join(' ') === '@e2 Seven' &&
              action.flags.delayMs === 1,
          ),
          'Expected ref fill action to be recorded on the session',
        );
        assert.ok(
          actions.some(
            (action) =>
              action.command === 'fill' &&
              action.positionals.join(' ') === '42 84 Eight' &&
              action.flags.delayMs === 1,
          ),
          'Expected coordinate fill action to be recorded on the session',
        );

        const close = await daemon.callCommand('close', ['gnome-calculator']);
        assert.equal(close.statusCode, 200, JSON.stringify(close.json));
        assert.deepEqual(desktopCalls, [
          ['open', 'gnome-calculator'],
          ['close', 'gnome-calculator'],
        ]);
        assertFlatToolCall(semanticCalls, ['accessibility', 'frontmost-app']);
        assertFlatToolCall(semanticCalls, ['clipboard', 'write', 'linux otp 314159']);
        assertFlatToolCall(semanticCalls, ['clipboard', 'read']);
        assertFlatToolCall(semanticCalls, ['screenshot', screenshotPath, 'true', 'false', 'app']);
        assertFlatToolCall(semanticCalls, ['input', 'click', '60', '100', 'primary']);
        assertFlatToolCall(semanticCalls, ['input', 'click', '42', '84', 'primary']);
        assertFlatToolCall(semanticCalls, ['input', 'click', '42', '84', 'secondary']);
        assertFlatToolCall(semanticCalls, ['input', 'click', '42', '84', 'middle']);
        assertFlatToolCall(semanticCalls, ['input', 'double-click', '42', '84']);
        assertFlatToolCall(semanticCalls, ['input', 'long-press', '42', '84', '1']);
        assertFlatToolCall(semanticCalls, ['input', 'drag', '10', '20', '30', '40', '16']);
        assertFlatToolCall(semanticCalls, ['input', 'type', 'Seven', '1']);
        assertFlatToolCall(semanticCalls, ['input', 'type', 'Eight', '1']);
        assertFlatToolCall(semanticCalls, ['input', 'type', '5', '0']);
        assertFlatToolCall(semanticCalls, ['input', 'key', 'ctrl+a']);
        assertFlatToolCall(semanticCalls, ['input', 'key', 'alt+Left']);
        assertFlatToolCall(semanticCalls, ['input', 'key', 'super+d']);
        assertFlatToolCall(semanticCalls, ['input', 'scroll', 'down', '', '45']);
        assertFlatToolCall(semanticCalls, ['input', 'scroll', 'up', '', '']);
        assert.deepEqual(
          toolCalls,
          [],
          'Expected Linux Provider-backed integration input to stay semantic',
        );
      } finally {
        fs.rmSync(screenshotPath, { force: true });
      }
    },
  );
});
