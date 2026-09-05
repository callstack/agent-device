import assert from 'node:assert/strict';
import { test } from 'vitest';
import { WEB_DESKTOP_DEVICE } from '../../../src/__tests__/test-utils/device-fixtures.ts';
import { createAgentBrowserWebProvider, type WebProvider } from '@agent-device/platform-web';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';
import {
  installFakeManagedAgentBrowser,
  withNodeRuntime,
} from '../../../src/__tests__/test-utils/web-managed-agent-browser.ts';
import { createProviderScenarioHarness } from './harness.ts';

test('web provider is scoped through the request router and dispatch path', async () => {
  const calls: string[] = [];
  const webProvider: WebProvider = {
    async open(target) {
      calls.push(`open:${target}`);
    },
    async close(target) {
      calls.push(`close:${target ?? ''}`);
    },
    async snapshot(options) {
      calls.push(`snapshot:${options?.scope ?? ''}`);
      return {
        nodes: [
          {
            index: 0,
            type: 'section',
            role: 'main',
            label: 'main',
            rect: { x: 0, y: 0, width: 320, height: 240 },
            depth: 0,
          },
          {
            index: 1,
            type: 'button',
            role: 'button',
            label: 'Launch',
            rect: { x: 10, y: 20, width: 80, height: 32 },
            hittable: true,
            depth: 1,
            parentIndex: 0,
          },
        ],
      };
    },
    async screenshot() {
      calls.push('screenshot');
    },
    async setViewport(width, height) {
      calls.push(`viewport:${width}:${height}`);
    },
    async click(x, y) {
      calls.push(`click:${x}:${y}`);
    },
    async fill(x, y, text) {
      calls.push(`fill:${x}:${y}:${text}`);
    },
    async typeText(text) {
      calls.push(`type:${text}`);
    },
    async scroll(direction) {
      calls.push(`scroll:${direction}`);
    },
    async dumpNetwork(options) {
      calls.push(`network:${options?.limit ?? ''}:${options?.include ?? ''}`);
      return {
        entries: [
          {
            timestamp: '2026-06-22T09:08:19.500Z',
            method: 'GET',
            url: 'https://example.test/api',
            status: 200,
            requestHeaders: { Accept: 'application/json' },
            responseHeaders: { 'content-type': 'application/json' },
            metadata: { requestId: 'req-1', resourceType: 'fetch' },
          },
        ],
        backend: 'agent-browser',
        redacted: false,
      };
    },
    async probeAudio(options) {
      calls.push(`audio:${options.action}:${options.durationMs ?? ''}:${options.bucketMs ?? ''}`);
      return {
        audio: 'probe',
        state: 'running',
        active: true,
        heard: true,
        source: 'media-elements',
        backend: 'agent-browser',
        durationMs: options.durationMs ?? 10_000,
        elapsedMs: 1000,
        bucketMs: options.bucketMs ?? 1000,
        sampleCount: 1,
        mediaElementCount: 1,
        sourceCount: 1,
        rmsDbfs: [-24],
        peakDbfs: [-12],
        notes: ['HTML media element probe'],
      };
    },
  };

  const harness = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [WEB_DESKTOP_DEVICE],
    platformRuntime: true,
    webProvider: ({ device, session }) => {
      calls.push(`scope:${session?.name ?? 'none'}:${device.id}`);
      return webProvider;
    },
  });

  try {
    const open = await harness.callCommand(
      'open',
      ['https://example.test'],
      { platform: 'web' },
      { meta: { requestId: 'req-web-open' } },
    );
    assert.equal(open.json.error, undefined);

    const snapshot = await harness.callCommand(
      'snapshot',
      [],
      { platform: 'web', snapshotScope: 'main' },
      { meta: { requestId: 'req-web-snapshot' } },
    );

    assert.deepEqual(snapshot.json.result.data.nodes, [
      {
        index: 0,
        type: 'section',
        role: 'main',
        label: 'main',
        rect: { x: 0, y: 0, width: 320, height: 240 },
        depth: 0,
        parentIndex: undefined,
        ref: 'e1',
      },
      {
        index: 1,
        type: 'button',
        role: 'button',
        label: 'Launch',
        rect: { x: 10, y: 20, width: 80, height: 32 },
        hittable: true,
        depth: 1,
        parentIndex: 0,
        ref: 'e2',
      },
    ]);

    const network = await harness.callCommand(
      'network',
      ['dump', '5'],
      { platform: 'web', networkInclude: 'headers' },
      { meta: { requestId: 'req-web-network' } },
    );
    assert.deepEqual(network.json.result.data.entries, [
      {
        timestamp: '2026-06-22T09:08:19.500Z',
        method: 'GET',
        url: 'https://example.test/api',
        status: 200,
        requestHeaders: { Accept: 'application/json' },
        responseHeaders: { 'content-type': 'application/json' },
        metadata: { requestId: 'req-1', resourceType: 'fetch' },
      },
    ]);
    assert.equal(network.json.result.data.backend, 'agent-browser');
    assert.equal(network.json.result.data.include, 'headers');
    const audio = await harness.callCommand(
      'audio',
      ['probe', 'start', '10000', '1000'],
      { platform: 'web' },
      { meta: { requestId: 'req-web-audio' } },
    );
    assert.deepEqual(audio.json.result.data.rmsDbfs, [-24]);
    assert.equal(audio.json.result.data.heard, true);

    const viewport = await harness.callCommand(
      'viewport',
      ['1280', '900'],
      { platform: 'web' },
      { meta: { requestId: 'req-web-viewport' } },
    );
    assert.deepEqual(viewport.json.result.data, {
      width: 1280,
      height: 900,
      message: 'Viewport set: 1280x900',
    });
    assert.deepEqual(calls, [
      'scope:none:agent-browser-chrome',
      'open:https://example.test',
      'scope:default:agent-browser-chrome',
      'snapshot:main',
      'scope:default:agent-browser-chrome',
      'network:5:headers',
      'scope:default:agent-browser-chrome',
      'audio:start:10000:1000',
      'scope:default:agent-browser-chrome',
      'viewport:1280:900',
    ]);
  } finally {
    await harness.close();
  }
});

test('non-dense browser refs survive snapshot storage and routed fill and click', async () => {
  const calls: string[][] = [];
  const values: Record<string, string> = { '@e2': '', '@e3': '' };
  let signedIn = false;
  const stateDir = mkdtempForTestSync('web-ref-route-');
  installFakeManagedAgentBrowser(stateDir);
  await withNodeRuntime({ version: '24.0.0' }, async () => {
    const provider = await createAgentBrowserWebProvider({ stateDir });
    await withCommandExecutorOverride(
      async (_command, args) => {
        const [command, ref, text] = args.slice(1);
        let data: unknown = {};
        if (command === 'snapshot') {
          data = {
            snapshot: [
              '- textbox "Username" [ref=e2]',
              '- textbox "Passcode" [ref=e3]',
              '- button "Sign in" [ref=e4]',
            ].join('\n'),
            refs: {
              e2: { role: 'textbox', name: 'Username' },
              e3: { role: 'textbox', name: 'Passcode' },
              e4: { role: 'button', name: 'Sign in' },
            },
          };
        } else if (command === 'fill') {
          calls.push(['fill', ref!, text!]);
          values[ref!] = text!;
        } else if (command === 'click') {
          calls.push(['click', ref!]);
          signedIn = ref === '@e4';
        } else {
          assert.ok(command === 'open' || command === 'close', `Unexpected command: ${args}`);
        }
        return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
      },
      async () => {
        const harness = await createProviderScenarioHarness({
          deviceInventoryProvider: async () => [WEB_DESKTOP_DEVICE],
          platformRuntime: true,
          webProvider: () => provider,
        });
        try {
          const open = await harness.callCommand('open', ['https://example.test/login'], {
            platform: 'web',
          });
          assert.equal(open.json.error, undefined);
          const snapshot = await harness.callCommand('snapshot', [], { platform: 'web' });
          assert.equal(snapshot.json.error, undefined);
          const nodes = snapshot.json.result.data.nodes;
          assert.deepEqual(
            nodes.map((node: { label: string; ref: string }) => [node.label, node.ref]),
            [
              ['Username', 'e2'],
              ['Passcode', 'e3'],
              ['Sign in', 'e4'],
            ],
          );
          const fill = await harness.callCommand('fill', [`@${nodes[0].ref}`, 'Ada']);
          assert.equal(fill.json.error, undefined);
          assert.deepEqual(values, { '@e2': 'Ada', '@e3': '' });

          const refreshed = await harness.callCommand('snapshot');
          assert.equal(refreshed.json.error, undefined);
          const button = refreshed.json.result.data.nodes.find(
            (node: { label: string }) => node.label === 'Sign in',
          );
          const click = await harness.callCommand('click', [`@${button.ref}`]);
          assert.equal(click.json.error, undefined);
          assert.equal(signedIn, true);
          assert.deepEqual(calls, [
            ['fill', '@e2', 'Ada'],
            ['click', '@e4'],
          ]);
        } finally {
          await harness.close();
        }
      },
    );
  });
});
