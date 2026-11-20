import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDevice } from '../../../runtime.ts';
import { createLocalArtifactAdapter } from '@agent-device/host-kit/local-artifact-adapter';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

test('runtime audit appends native issues without altering heuristic findings or assigning native refs', async () => {
  const nativeAuditFindings = [
    {
      source: 'native',
      kind: 'native',
      severity: 'warning',
      platform: 'ios',
      auditType: 'contrast',
      description: 'Low contrast',
      rect: { x: 1, y: 2, width: 3, height: 4 },
    },
  ] as const;
  const calls: string[] = [];
  const capture = {
    snapshot: makeSnapshotState(
      [
        {
          index: 0,
          depth: 0,
          type: 'Button',
          hittable: true,
          rect: { x: 10, y: 20, width: 22, height: 22 },
        },
      ],
      { backend: 'xctest' },
    ),
  };
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureSnapshot: async () => {
        calls.push('snapshot');
        return capture;
      },
      accessibilityAudit: async () => {
        calls.push('audit');
        return [...nativeAuditFindings];
      },
    },
    artifacts: createLocalArtifactAdapter(),
    sessions: { get: () => undefined, set: () => {} },
    policy: localCommandPolicy(),
  });
  const result = await device.capture.auditSnapshot({});
  assert.deepEqual(calls, ['snapshot', 'audit']);
  assert.equal(result.findings.filter((finding) => finding.kind === 'small-target').length, 1);
  assert.deepEqual(
    result.findings.filter((finding) => finding.kind === 'native'),
    nativeAuditFindings,
  );
});
