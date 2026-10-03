import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appleRunnerHostPortViolations, RUNNER_SUBTREE } from './apple-runner-host-port-policy.ts';

function sources(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}

test('a runner module value-importing host-kit directly is refused', () => {
  const violations = appleRunnerHostPortViolations(
    sources({
      [`${RUNNER_SUBTREE}runner-planted.ts`]:
        "import { runCmdSync } from '@agent-device/host-kit/command';\n",
    }),
  );
  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.equal(violation!.rule, 'R77 apple-runner-host-port');
  assert.equal(violation!.file, `${RUNNER_SUBTREE}runner-planted.ts`);
  assert.equal(violation!.line, 1);
  assert.match(violation!.message, /runner host port/);
  assert.match(violation!.message, /runner\/host\.ts, bound in core\/runner-host\.ts/);
  assert.match(violation!.message, /eager-closure-budgets/);
});

test('every value-import form that reaches host-kit is refused', () => {
  for (const source of [
    "import { runCmdSync } from '@agent-device/host-kit/command';",
    "import * as command from '@agent-device/host-kit/command';",
    "const command = await import('@agent-device/host-kit/command');",
    "export { runCmdSync } from '@agent-device/host-kit/command';",
    "export * from '@agent-device/host-kit/command';",
    "import '@agent-device/host-kit/command';",
  ]) {
    const violations = appleRunnerHostPortViolations(
      sources({ [`${RUNNER_SUBTREE}runner-planted.ts`]: source }),
    );
    assert.equal(violations.length, 1, source);
  }
});

test('a type-only host-kit import is exempt, in the runner subtree and on the port itself', () => {
  assert.deepEqual(
    appleRunnerHostPortViolations(
      sources({
        [`${RUNNER_SUBTREE}runner-planted.ts`]:
          "import type { ExecResult } from '@agent-device/host-kit/command';\n",
        [`${RUNNER_SUBTREE}host.ts`]:
          "import type { ExecOptions } from '@agent-device/host-kit/command';\n",
      }),
    ),
    [],
  );
});

test('a host-kit import outside the runner subtree is not this rule’s concern', () => {
  assert.deepEqual(
    appleRunnerHostPortViolations(
      sources({
        'packages/platform-apple/src/core/runner-host.ts':
          "import { runCmdSync } from '@agent-device/host-kit/command';\n",
      }),
    ),
    [],
  );
});

test('a runner import of anything other than host-kit is not this rule’s concern', () => {
  assert.deepEqual(
    appleRunnerHostPortViolations(
      sources({
        [`${RUNNER_SUBTREE}runner-planted.ts`]: [
          "import { PLATFORMS } from '@agent-device/kernel/device';",
          "import { runCmdSync } from './host.ts';",
        ].join('\n'),
      }),
    ),
    [],
  );
});
