import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandProviderPolicyViolations } from './command-provider-policy.ts';

test('command implementations cannot branch on provider identity', () => {
  const violations = commandProviderPolicyViolations(
    new Map([
      ['src/cli/commands/open.ts', `if (state.leaseProvider === 'limrun') open();`],
      ['src/commands/apps.ts', `if ('browserstack' !== verification['provider']) return;`],
      [
        'src/cli/commands/connect.ts',
        `if (verification?.provider === 'aws-device-farm') reconnect();`,
      ],
      ['src/cli/commands/session.ts', `switch (state.leaseProvider) { case 'proxy': connect(); }`],
      ['src/cli/connection/provider-policy.ts', `export const supported = provider === 'limrun';`],
      [
        'src/cli/commands/devices.ts',
        `if (connectionProviderSupportsApps(state.leaseProvider)) list();`,
      ],
    ]),
  );

  assert.deepEqual(
    violations.map(({ file, line }) => ({ file, line })),
    [
      { file: 'src/cli/commands/open.ts', line: 1 },
      { file: 'src/commands/apps.ts', line: 1 },
      { file: 'src/cli/commands/connect.ts', line: 1 },
      { file: 'src/cli/commands/session.ts', line: 1 },
    ],
  );
});
