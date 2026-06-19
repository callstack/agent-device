import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { assertFlatToolCall, assertPngFile } from './assertions.ts';
import { PROVIDER_SCENARIO_WEB } from './fixtures.ts';
import { createProviderScenarioTempPath, withProviderScenarioResource } from './harness.ts';
import { runProviderScenario } from './scenario.ts';
import { createWebDesktopWorld } from './web-world.ts';

const WEB_URL = 'https://example.test/dashboard';

test('Provider-backed integration web desktop flow uses semantic web provider calls', async () => {
  await withProviderScenarioResource(createWebDesktopWorld, async ({ daemon, semanticCalls }) => {
    const screenshotPath = createProviderScenarioTempPath(
      'agent-device-provider-scenario-web',
      'png',
    );

    try {
      const devices = await daemon.client().devices.list({ platform: 'web' });
      assert.equal(devices.length, 1);
      assert.equal(devices[0]?.platform, 'web');
      assert.equal(devices[0]?.id, PROVIDER_SCENARIO_WEB.id);
      assert.equal(devices[0]?.target, 'desktop');

      await runProviderScenario(daemon, [
        {
          name: 'open web URL',
          command: 'open',
          positionals: [WEB_URL],
          flags: { platform: 'web' },
        },
        {
          name: 'capture interactive web snapshot',
          command: 'snapshot',
          flags: { snapshotInteractiveOnly: true },
          assert: (snapshot) => {
            const labels = snapshot.json?.result?.data?.nodes?.map(
              (node: { label?: string }) => node.label,
            );
            assert.deepEqual(labels, [
              WEB_URL,
              'Ready',
              'Email',
              'Submit order',
              'Ready',
              'Below the fold',
            ]);
          },
        },
        {
          name: 'read snapshot ref text',
          command: 'get',
          positionals: ['text', '@e2'],
          expectData: { text: 'Ready' },
        },
        {
          name: 'find visible text',
          command: 'find',
          positionals: ['text', 'Submit order', 'exists'],
          expectData: { found: true },
        },
        {
          name: 'assert visible text',
          command: 'is',
          positionals: ['visible', 'label="Submit order"'],
          expectData: { pass: true },
        },
        {
          name: 'wait for text',
          command: 'wait',
          positionals: ['text', 'Ready', '100'],
          expectData: { text: 'Ready' },
        },
        {
          name: 'click submit ref',
          command: 'click',
          positionals: ['@e4'],
          expectData: { x: 84, y: 166 },
        },
        {
          name: 'fill email ref',
          command: 'fill',
          positionals: ['@e3', 'qa@example.test'],
          flags: { delayMs: 1 },
          expectData: { text: 'qa@example.test' },
        },
        {
          name: 'type suffix',
          command: 'type',
          positionals: [' ok'],
          expectData: { text: ' ok' },
        },
        {
          name: 'scroll by pixels',
          command: 'scroll',
          positionals: ['down'],
          flags: { pixels: 240 },
          expectData: { pixels: 240 },
        },
        {
          name: 'capture web screenshot artifact',
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
      ]);

      const actions = daemon.session()?.actions ?? [];
      assert.ok(
        actions.some(
          (action) => action.command === 'click' && action.positionals.join(' ') === '@e4',
        ),
        'Expected ref click action to be recorded on the session',
      );
      assert.ok(
        actions.some(
          (action) =>
            action.command === 'fill' &&
            action.positionals.join(' ') === '@e3 qa@example.test' &&
            action.flags.delayMs === 1,
        ),
        'Expected ref fill action to be recorded on the session',
      );
      assert.ok(
        actions.some(
          (action) => action.command === 'type' && action.positionals.join(' ') === ' ok',
        ),
        'Expected type action to be recorded on the session',
      );

      const close = await daemon.callCommand('close', [WEB_URL]);
      assert.equal(close.statusCode, 200, JSON.stringify(close.json));

      assertFlatToolCall(semanticCalls, ['web', 'open', WEB_URL, '']);
      assertFlatToolCall(semanticCalls, ['web', 'snapshot', 'true', '']);
      assertFlatToolCall(semanticCalls, ['web', 'click', '84', '166']);
      assertFlatToolCall(semanticCalls, ['web', 'fill', '144', '114', 'qa@example.test', '1']);
      assertFlatToolCall(semanticCalls, ['web', 'type', ' ok', '0']);
      assertFlatToolCall(semanticCalls, ['web', 'scroll', 'down', '', '240']);
      assertFlatToolCall(semanticCalls, [
        'web',
        'screenshot',
        screenshotPath,
        'true',
        'false',
        'app',
      ]);
      assertFlatToolCall(semanticCalls, ['web', 'close', WEB_URL]);
    } finally {
      fs.rmSync(screenshotPath, { force: true });
    }
  });
}, 10_000);
