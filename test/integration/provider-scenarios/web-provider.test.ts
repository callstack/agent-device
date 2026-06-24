import assert from 'node:assert/strict';
import { test } from 'vitest';
import { WEB_DESKTOP_DEVICE } from '../../../src/__tests__/test-utils/index.ts';
import type { WebProvider } from '../../../src/platforms/web/provider.ts';
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
  };

  const harness = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [WEB_DESKTOP_DEVICE],
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
      'viewport:1280:900',
    ]);
  } finally {
    await harness.close();
  }
});
