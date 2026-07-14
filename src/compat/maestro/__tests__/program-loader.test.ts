import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createMaestroProgramLoader, resolveMaestroIncludePath } from '../program-loader.ts';

test('resolves nested Maestro includes relative to their parent source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-loader-'));
  const flowDir = path.join(root, 'flows');
  fs.mkdirSync(flowDir);
  const childPath = path.join(flowDir, 'child.yaml');
  fs.writeFileSync(childPath, '---\n- inputText: child\n');

  const loader = createMaestroProgramLoader(root);
  const program = await loader('./child.yaml', path.join(flowDir, 'parent.yaml'));

  expect(program.source.path).toBe(childPath);
  expect(program.commands[0]).toMatchObject({ kind: 'inputText', text: 'child' });
  expect(resolveMaestroIncludePath('./root.yaml', undefined, root)).toBe(
    path.join(root, 'root.yaml'),
  );
});

test('caches parsed programs by resolved path and honors cancellation before I/O', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-loader-cache-'));
  const childPath = path.join(root, 'child.yaml');
  fs.writeFileSync(childPath, '---\n- back\n');
  const readFileSync = vi.spyOn(fs, 'readFileSync');
  const loader = createMaestroProgramLoader(root);

  await loader('child.yaml');
  await loader('./child.yaml');
  expect(readFileSync.mock.calls.filter(([entry]) => entry === childPath)).toHaveLength(1);

  const controller = new AbortController();
  controller.abort();
  await expect(loader('missing.yaml', undefined, controller.signal)).rejects.toMatchObject({
    details: { reason: 'request_canceled' },
  });
  readFileSync.mockRestore();
});

test('preserves the resolved child source path when an included flow is unsupported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-loader-error-'));
  const childPath = path.join(root, 'child.yaml');
  fs.writeFileSync(childPath, '---\n- unsupportedCommand: true\n');

  const loader = createMaestroProgramLoader(root);

  await expect(loader('child.yaml')).rejects.toThrow(`${childPath}:line 2`);
});
