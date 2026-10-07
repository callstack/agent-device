import { test } from 'vitest';
import assert from 'node:assert/strict';
import { findHostRpcRefusal, stripClientIdentity } from './request-policy.ts';

const COMMAND = 'agent_device.command';

test('positionals naming a Host file are refused; client-rewritten locations are not', () => {
  const refused = [
    { command: 'install', positionals: ['com.example.app', '/Users/operator/app.apk'] },
    { command: 'record', positionals: ['start', '/Users/operator/out.mp4'] },
    { command: 'screenshot', positionals: ['/etc/agent-device.png'] },
    { command: 'install', positionals: ['com.example.app', 'https://x/../../Users/op/app.apk'] },
    { command: 'install', positionals: ['app.apk'] },
  ];
  for (const params of refused) {
    assert.equal(findHostRpcRefusal(COMMAND, params)?.reason, 'host-path-refused', params.command);
  }

  const accepted = [
    { command: 'record', positionals: ['start', '/tmp/agent-device-recording-1-k3x9qa.mp4'] },
    { command: 'screenshot', positionals: ['/tmp/agent-device-screenshot-1-k3x9qa.png'] },
    { command: 'record', positionals: ['stop'] },
  ];
  for (const params of accepted) {
    assert.equal(findHostRpcRefusal(COMMAND, params), undefined, params.command);
  }
});

test('an uploaded install keeps its client-local path and is accepted', () => {
  assert.equal(
    findHostRpcRefusal(COMMAND, {
      command: 'install',
      positionals: ['com.example.app', './build/app.apk'],
      meta: { uploadedArtifactId: 'upload-1', installSource: { kind: 'path', path: '/x' } },
    }),
    undefined,
  );
});

test('identity claims are removed and attribution is kept', () => {
  assert.deepEqual(
    stripClientIdentity({
      tenant: 'a',
      tenantId: 'b',
      runId: 'verify-812',
      meta: { tenantId: 'c', clientId: 'ab12cd34' },
      flags: { tenant: 'd', platform: 'ios' },
    }),
    { runId: 'verify-812', meta: { clientId: 'ab12cd34' }, flags: { platform: 'ios' } },
  );
});
