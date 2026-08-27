import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeExecutionIntegrityViolations } from './runtime-execution-policy.ts';

const REGISTRY = 'src/core/command-descriptor/registry.ts';
const ADMISSION = 'src/daemon/runtime-admission.ts';

function sources(entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> {
  return new Map(entries);
}

function admission(body: string): string {
  return `
    function requireFactsInspection(value) { return value; }
    function requireDeviceBinding(value) { return value; }
    export async function admitRuntimeOperations(request) {
      ${body}
    }
  `;
}

function messages(entries: readonly (readonly [string, string])[]): string[] {
  return runtimeExecutionIntegrityViolations(sources(entries)).map(({ message }) => message);
}

test('the permanent runtime policy accepts facts-only admission and typed operation access', () => {
  assert.deepEqual(
    messages([
      [REGISTRY, `const descriptor = { name: 'focus', platformExecution: { kind: 'none' } };`],
      [
        ADMISSION,
        admission(`
          const inspect = requireFactsInspection(request.inspectFacts);
          const bind = requireDeviceBinding(request.bindDevice);
          return { inspect, bind };
        `),
      ],
      [
        'src/daemon/handler.ts',
        `async function run(runtime) { return runtime.operations.focusPoint(input); }`,
      ],
    ]),
    [],
  );
});

test('a descriptor capability bucket and legacy admission call are rejected globally', () => {
  const found = messages([
    [
      REGISTRY,
      `const descriptor = { name: 'focus', capability: { apple: {} }, platformExecution: { kind: 'none' } };`,
    ],
    [
      ADMISSION,
      admission(
        `requireFactsInspection(request.inspectFacts); requireDeviceBinding(request.bindDevice);`,
      ),
    ],
    ['src/daemon/planted.ts', `requireCommandSupported('focus', device);`],
  ]);
  assert.deepEqual(found, [
    'command descriptors may not restore capability-bucket admission',
    'runtime facts are the only device-command admission authority',
  ]);
});

test('daemon code cannot cast, assert, or bracket its way around runtime narrowing', () => {
  const found = messages([
    [REGISTRY, `const descriptor = { platformExecution: { kind: 'none' } };`],
    [
      ADMISSION,
      admission(
        `requireFactsInspection(request.inspectFacts); requireDeviceBinding(request.bindDevice);`,
      ),
    ],
    [
      'src/daemon/planted.ts',
      `
        const forged = value as BoundDeviceRuntime<typeof use>;
        runtime.operations.focusPoint!;
        runtime.operations['focusPoint'](input);
        runtime.operations['focus' + 'Point'](input);
        runtime['operations'].focusPoint!;
      `,
    ],
  ]);
  assert.deepEqual(found, [
    'daemon code may not manufacture a narrowed runtime proof',
    'daemon code may not repair a missing runtime operation with !',
    'daemon code must consume narrowed runtime operations through named properties',
    'daemon code must consume narrowed runtime operations through named properties',
    'daemon code may not repair a missing runtime operation with !',
  ]);
});

test('dynamic operation iteration used by admission remains legal', () => {
  assert.deepEqual(
    messages([
      [REGISTRY, `const descriptor = { platformExecution: { kind: 'none' } };`],
      [
        ADMISSION,
        admission(
          `requireFactsInspection(request.inspectFacts); requireDeviceBinding(request.bindDevice);`,
        ),
      ],
      ['src/daemon/planted.ts', `const fact = facts.operations[operation];`],
    ]),
    [],
  );
});

test('shared admission must inspect facts and expose binding exactly once', () => {
  const found = messages([
    [REGISTRY, `const descriptor = { platformExecution: { kind: 'none' } };`],
    [
      ADMISSION,
      admission(`
        requireFactsInspection(request.inspectFacts);
        requireFactsInspection(request.inspectFacts);
        return request.bindDevice;
      `),
    ],
  ]);
  assert.deepEqual(found, [
    'shared runtime admission must make one facts inspection call (found 2)',
    'shared runtime admission must make one binding call (found 0)',
  ]);
});

test('shared admission cannot hide an additional inspection behind an alias', () => {
  const found = messages([
    [REGISTRY, `const descriptor = { platformExecution: { kind: 'none' } };`],
    [
      ADMISSION,
      admission(`
        requireFactsInspection(request.inspectFacts);
        const inspectAgain = requireFactsInspection;
        inspectAgain(request.inspectFacts);
        requireDeviceBinding(request.bindDevice);
      `),
    ],
  ]);
  assert.deepEqual(found, [
    'shared runtime admission must call requireFactsInspection directly without aliasing it',
  ]);
});
