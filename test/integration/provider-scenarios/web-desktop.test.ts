import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { interactionCliOutputFormatters } from '../../../src/commands/interaction/output.ts';
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
    const recordingPath = createProviderScenarioTempPath(
      'agent-device-provider-scenario-web-recording',
      'webm',
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
          name: 'start web recording',
          command: 'record',
          positionals: ['start', recordingPath],
          expectData: { recording: 'started', outPath: recordingPath },
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
        // #2283, the whole reason a web capture mints no refs of its own: this node reached the
        // stored state through `buildSnapshotState` with agent-browser provenance and carries no
        // ref, so it must be published, listed and waited on without ever being offered an
        // address. Delete `snapshotRefMinting(data)` from snapshot-state and this block turns red
        // on the first step (the node would be minted `e7`, colliding with nothing here and with a
        // real control on a real page).
        {
          name: 'publish the ref-less text with no ref key',
          command: 'snapshot',
          flags: { snapshotInteractiveOnly: false },
          assert: (response) => {
            const nodes = response.json?.result?.data?.nodes as
              | Array<Record<string, unknown>>
              | undefined;
            const refLess = nodes?.find((node) => node.value === 'Order saved');
            assert.ok(
              refLess,
              `Ref-less text missing from the published tree: ${JSON.stringify(nodes)}`,
            );
            assert.equal('ref' in refLess, false, JSON.stringify(refLess));
          },
        },
        {
          name: 'list the ref-less text without an address',
          command: 'find',
          positionals: ['text', 'Order saved', 'list'],
          assert: async (response) => {
            const matches = response.json?.result?.data?.matches as
              | Array<Record<string, unknown>>
              | undefined;
            assert.equal(matches?.length, 1, JSON.stringify(response.json?.result?.data));
            assert.equal('ref' in (matches?.[0] ?? {}), false, JSON.stringify(matches?.[0]));
            const cli = await interactionCliOutputFormatters.find({
              input: {},
              result: response.json?.result?.data,
            });
            assert.equal(cli.text, ['1 match:', '= (no ref) [text] "Order saved"'].join('\n'));
          },
        },
        {
          name: 'wait for the ref-less text',
          command: 'wait',
          positionals: ['text', 'Order saved', '100'],
          expectData: { text: 'Order saved' },
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
          // #1783: hover @ref on web rides the provider element handle
          // (hoverRef), never a coordinate — web ref frames carry no rects.
          name: 'hover submit ref',
          command: 'hover',
          positionals: ['@e4'],
          expectData: { ref: 'e4', gesture: 'hover' },
          assert: (response) => {
            const data = response.json?.result?.data;
            assert.equal(data?.x, undefined);
            assert.equal(data?.y, undefined);
            assert.equal(data?.message, 'Hovered @e4');
          },
        },
        {
          // ADR 0014: the ref hover above expired the frame; re-observe
          // before the next ref mutation.
          name: 're-observe before the ref click',
          command: 'snapshot',
          flags: { snapshotInteractiveOnly: true },
        },
        {
          name: 'click submit ref',
          command: 'click',
          positionals: ['@e4'],
          expectData: { ref: 'e4' },
          assert: (response) => {
            const data = response.json?.result?.data;
            assert.equal(data?.x, undefined);
            assert.equal(data?.y, undefined);
            assert.equal(data?.message, 'Tapped @e4');
          },
        },
        {
          // ADR 0014: the ref click above expired the frame, so a fresh
          // observation is required before the next ref mutation.
          name: 're-observe before the next ref mutation',
          command: 'snapshot',
          flags: { snapshotInteractiveOnly: true },
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
          name: 'resize viewport',
          command: 'viewport',
          positionals: ['1280', '900'],
          expectData: { width: 1280, height: 900 },
        },
        {
          name: 'capture full-page web screenshot artifact',
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
        {
          name: 'stop web recording',
          command: 'record',
          positionals: ['stop'],
          expectData: { recording: 'stopped', outPath: recordingPath },
        },
      ]);

      // This step pins the acting row's `requireRect`, not the minting rule: a ref-less line is one
      // the backend never measured and never issued a handle for, and a line the backend DID mint a
      // ref for still carries no rect here, so this refusal would hold either way. The minting rule
      // itself is pinned by the `snapshot --json` and `find text … list` assertions above. The
      // refusal has to name no match — an action here would be a blind tap, which is the collision
      // #2283 is about.
      const refLessClick = await daemon.callCommand('click', ['text="Order saved"']);
      assert.equal(
        refLessClick.json?.error?.data?.details?.reason,
        'selector_not_found',
        JSON.stringify(refLessClick.json),
      );

      const close = await daemon.callCommand('close', [WEB_URL]);
      assert.equal(close.statusCode, 200, JSON.stringify(close.json));

      assertFlatToolCall(semanticCalls, ['web', 'open', WEB_URL, '']);
      assertFlatToolCall(semanticCalls, ['web', 'recordStart', recordingPath]);
      assertFlatToolCall(semanticCalls, ['web', 'snapshot', 'true', 'app']);
      assertFlatToolCall(semanticCalls, ['web', 'hoverRef', '@e4']);
      assertFlatToolCall(semanticCalls, ['web', 'clickRef', '@e4']);
      assertFlatToolCall(semanticCalls, ['web', 'fillRef', '@e3', 'qa@example.test', '1']);
      assertFlatToolCall(semanticCalls, ['web', 'type', ' ok', '0']);
      assertFlatToolCall(semanticCalls, ['web', 'scroll', 'down', '', '240']);
      assertFlatToolCall(semanticCalls, ['web', 'viewport', '1280', '900']);
      assertFlatToolCall(semanticCalls, [
        'web',
        'screenshot',
        screenshotPath,
        'true',
        'false',
        'app',
      ]);
      assertFlatToolCall(semanticCalls, ['web', 'recordStop']);
      assertFlatToolCall(semanticCalls, ['web', 'close', WEB_URL]);
    } finally {
      fs.rmSync(screenshotPath, { force: true });
      fs.rmSync(recordingPath, { force: true });
    }
  });
}, 10_000);
