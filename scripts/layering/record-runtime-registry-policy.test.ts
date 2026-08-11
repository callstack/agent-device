import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordRuntimeRegistryJoinViolations } from './record-runtime-registry-policy.ts';

test('R16 requires the real registry normalization path to assert the record use join', () => {
  assert.deepEqual(
    recordRuntimeRegistryJoinViolations([
      {
        path: 'src/core/command-descriptor/registry.ts',
        source: `
          import { assertRecordRuntimeExecution as assertRecord } from '@agent-device/contracts/platform';
          if (descriptor.name === 'record') assertRecord(platformExecution);
        `,
      },
    ]),
    [],
  );
  assert.deepEqual(
    recordRuntimeRegistryJoinViolations([
      {
        path: 'src/core/command-descriptor/registry.ts',
        source: `
          // assertRecordRuntimeExecution(platformExecution) is only prose.
          const prose = 'record descriptor assertion';
          normalize(platformExecution);
        `,
      },
    ]),
    ['src/core/command-descriptor/registry.ts: missing record runtime descriptor join assertion'],
  );
});
