import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { executeMaestroFile } from '../file-execution.ts';
import type { MaestroRuntimePort } from '../engine-types.ts';

test('executes root and included Maestro files through one typed runtime port', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-file-'));
  const childPath = path.join(root, 'child.yaml');
  const mainPath = path.join(root, 'main.yaml');
  fs.writeFileSync(childPath, '---\n- inputText: ${VALUE}\n');
  fs.writeFileSync(
    mainPath,
    ['appId: com.example.app', '---', '- runFlow:', '    file: child.yaml'].join('\n'),
  );
  const execute = vi.fn(async () => ({ mutated: true }));
  const port: MaestroRuntimePort = {
    execute,
    observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
  };

  const result = await executeMaestroFile({
    filePath: mainPath,
    port,
    env: { VALUE: 'runtime' },
    platform: 'android',
  });

  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      appId: 'com.example.app',
      command: expect.objectContaining({ kind: 'inputText', text: 'runtime' }),
    }),
  );
  expect(result).toMatchObject({ executed: 2, generation: 1 });
});
