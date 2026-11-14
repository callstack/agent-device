import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { startAgentDevice } from '../../host.ts';
import { createCommandToolExecutor } from '../command-tools.ts';

test.each([undefined, 'declared'] as const)(
  'MCP preserves optional replay recovery through the real client/router in %s mode',
  async (structuredContent) => {
    const root = mkdtempForTestSync('mcp-replay-plugin-');
    const script = path.join(root, 'flow.ad');
    fs.writeFileSync(script, 'open com.example.app\nclose\n');
    const runtime = await startAgentDevice({
      stateDir: path.join(root, 'state'),
      plugins: [],
      host: createTestHostEnvironment({ env: { AGENT_DEVICE_HOME: path.join(root, 'home') } }),
    });
    try {
      const executor = createCommandToolExecutor({
        createClient: () => runtime.client,
        structuredContent,
      });
      for (const [command, input] of [
        ['replay', { path: script }],
        ['test', { paths: [script] }],
      ] as const) {
        const result = await executor.execute(command, input);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain('agent-device plugins add @agent-device/replay');
        expect(result.content[0]?.text).toContain('original command with all its arguments');
        if (structuredContent)
          expect(result.structuredContent).toMatchObject({
            code: 'INVALID_ARGS',
            details: {
              reason: 'plugin-not-installed',
              package: '@agent-device/replay',
              installCommand: 'agent-device plugins add @agent-device/replay',
            },
          });
        else expect(result.structuredContent).toBeUndefined();
      }
    } finally {
      await runtime.close();
    }
  },
);
