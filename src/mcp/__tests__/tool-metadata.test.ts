import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMcpMessageHandler } from '../router.ts';

type AdvertisedTool = {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

for (const structured of [false, true]) {
  test(`tools/list declares titles and effects for every tool (structured=${structured})`, async () => {
    const response = await createMcpMessageHandler({ structured })({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    assert.ok(response && 'result' in response);
    const { tools } = response.result as { tools: AdvertisedTool[] };
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.ok(tool.title?.trim(), `${tool.name}: missing title`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', tool.name);
      assert.equal(typeof tool.annotations?.destructiveHint, 'boolean', tool.name);
    }
    for (const name of ['devices', 'apps', 'get', 'is', 'help']) {
      assert.deepEqual(
        tools.find((tool) => tool.name === name)?.annotations,
        {
          readOnlyHint: true,
          destructiveHint: false,
        },
        name,
      );
    }
    for (const name of [
      'find',
      'clipboard',
      'session',
      'batch',
      'replay',
      'test',
      'shutdown',
      'doctor',
      'screenshot',
    ]) {
      assert.deepEqual(
        tools.find((tool) => tool.name === name)?.annotations,
        {
          readOnlyHint: false,
          destructiveHint: true,
        },
        name,
      );
    }
  });
}
