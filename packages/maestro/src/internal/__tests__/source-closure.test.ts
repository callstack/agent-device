import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { collectMaestroFlowSources } from '../source-closure.ts';

const ROOT = path.resolve('/flows');
const entryPath = path.join(ROOT, 'parent.yaml');

function readerFor(files: Record<string, string>): (resolvedPath: string) => string | undefined {
  return (resolvedPath) => files[resolvedPath];
}

// #1802: the caller ships every flow file the run can read, so the collector has to reach the
// includes nested inside `repeat`/`retry`/inline `runFlow.commands` and the lifecycle hooks —
// not just the top-level ones — and it has to do it transitively.
test('collects every transitively reachable runFlow include exactly once', () => {
  const entrySource = [
    'appId: com.example.app',
    'onFlowStart:',
    '  - runFlow: setup.yaml',
    'onFlowComplete:',
    '  - runFlow: teardown.yaml',
    '---',
    '- runFlow: shared.yaml',
    '- repeat:',
    '    times: 2',
    '    commands:',
    '      - runFlow: looped.yaml',
    '- runFlow:',
    '    commands:',
    '      - runFlow: inline-child.yaml',
    '- runFlow: shared.yaml',
  ].join('\n');
  const readSource = vi.fn(
    readerFor({
      [path.join(ROOT, 'setup.yaml')]: '---\n- back\n',
      [path.join(ROOT, 'teardown.yaml')]: '---\n- back\n',
      [path.join(ROOT, 'shared.yaml')]: '---\n- runFlow: nested/deep.yaml\n',
      [path.join(ROOT, 'looped.yaml')]: '---\n- back\n',
      [path.join(ROOT, 'inline-child.yaml')]: '---\n- back\n',
      [path.join(ROOT, 'nested', 'deep.yaml')]: '---\n- back\n',
    }),
  );

  const files = collectMaestroFlowSources({ entryPath, entrySource, readSource });

  expect(Object.keys(files).sort()).toEqual(
    [
      entryPath,
      path.join(ROOT, 'setup.yaml'),
      path.join(ROOT, 'teardown.yaml'),
      path.join(ROOT, 'shared.yaml'),
      path.join(ROOT, 'looped.yaml'),
      path.join(ROOT, 'inline-child.yaml'),
      path.join(ROOT, 'nested', 'deep.yaml'),
    ].sort(),
  );
  expect(
    readSource.mock.calls.filter(([entry]) => entry === path.join(ROOT, 'shared.yaml')),
  ).toHaveLength(1);
});

test('stops at a runFlow cycle instead of recursing forever', () => {
  const files = collectMaestroFlowSources({
    entryPath,
    entrySource: '---\n- runFlow: child.yaml\n',
    readSource: readerFor({
      [path.join(ROOT, 'child.yaml')]: '---\n- runFlow: parent.yaml\n',
    }),
  });

  expect(Object.keys(files).sort()).toEqual([path.join(ROOT, 'child.yaml'), entryPath].sort());
});

test('resolves a templated include path from the variables the caller already has', () => {
  const files = collectMaestroFlowSources({
    entryPath,
    entrySource: ['env:', '  FLOW_NAME: checkout', '---', '- runFlow: ${FLOW_NAME}.yaml'].join(
      '\n',
    ),
    readSource: readerFor({ [path.join(ROOT, 'checkout.yaml')]: '---\n- back\n' }),
  });

  expect(Object.keys(files)).toContain(path.join(ROOT, 'checkout.yaml'));
});

// Best effort past the entry flow: a `when:`-guarded include may never run, and an include path
// keyed on a value only the daemon binds cannot be known here. Neither may fail the collection —
// the run reports precisely which file was missing if it turns out to need one.
test('skips an include it cannot resolve or read without failing collection', () => {
  const files = collectMaestroFlowSources({
    entryPath,
    entrySource: [
      '---',
      '- runFlow: ${UNKNOWN_FLOW}.yaml',
      '- runFlow: absent.yaml',
      '- runFlow: broken.yaml',
    ].join('\n'),
    readSource: readerFor({
      [path.join(ROOT, 'broken.yaml')]: '---\n- unsupportedCommand: true\n',
    }),
  });

  expect(Object.keys(files).sort()).toEqual([entryPath, path.join(ROOT, 'broken.yaml')].sort());
});

test('returns the entry alone when the entry flow does not parse', () => {
  const entrySource = '---\n- unsupportedCommand: true\n';

  expect(
    collectMaestroFlowSources({
      entryPath,
      entrySource,
      readSource: () => {
        throw new Error('must not read past an unparseable entry');
      },
    }),
  ).toEqual({ [entryPath]: entrySource });
});
