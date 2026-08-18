import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createMaestroProgramLoader, resolveMaestroIncludePath } from '../program-loader.ts';

const ROOT = path.resolve('/flows');

function sourceReaderFor(files: Record<string, string>): (resolvedPath: string) => string {
  return (resolvedPath) => {
    const source = files[resolvedPath];
    if (source === undefined) throw new Error(`no source for ${resolvedPath}`);
    return source;
  };
}

test('resolves nested Maestro includes relative to their parent source', async () => {
  const flowDir = path.join(ROOT, 'nested');
  const childPath = path.join(flowDir, 'child.yaml');
  const loader = createMaestroProgramLoader(
    ROOT,
    sourceReaderFor({ [childPath]: '---\n- inputText: child\n' }),
  );

  const program = await loader('./child.yaml', path.join(flowDir, 'parent.yaml'));

  expect(program.source.path).toBe(childPath);
  expect(program.commands[0]).toMatchObject({ kind: 'inputText', text: 'child' });
  expect(resolveMaestroIncludePath('./root.yaml', undefined, ROOT)).toBe(
    path.join(ROOT, 'root.yaml'),
  );
});

test('caches parsed programs by resolved path and honors cancellation before reading', async () => {
  const childPath = path.join(ROOT, 'child.yaml');
  const readSource = vi.fn(sourceReaderFor({ [childPath]: '---\n- back\n' }));
  const loader = createMaestroProgramLoader(ROOT, readSource);

  await loader('child.yaml');
  await loader('./child.yaml');
  expect(readSource.mock.calls.filter(([entry]) => entry === childPath)).toHaveLength(1);

  const controller = new AbortController();
  controller.abort();
  await expect(loader('missing.yaml', undefined, controller.signal)).rejects.toMatchObject({
    details: { reason: 'request_canceled' },
  });
  expect(readSource).toHaveBeenCalledTimes(1);
});

test('preserves the resolved child source path when an included flow is unsupported', async () => {
  const childPath = path.join(ROOT, 'child.yaml');
  const loader = createMaestroProgramLoader(
    ROOT,
    sourceReaderFor({ [childPath]: '---\n- unsupportedCommand: true\n' }),
  );

  await expect(loader('child.yaml')).rejects.toThrow(`${childPath}:line 2`);
});
