import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

test('daemon auth tokens are scrubbed from CLI diagnostics and serialized requests', async () => {
  const home = mkdtempForTestSync('agent-device-auth-diagnostics-');
  const authToken = 'opaque-auth-value-1348';
  try {
    const result = await runCliCapture(
      [
        'devices',
        '--daemon-base-url',
        'https://daemon.example.test',
        '--daemon-auth-token',
        authToken,
        '--json',
      ],
      {
        env: { HOME: home },
        sendToDaemon: async () => {
          emitDiagnostic({
            phase: 'synthetic_transport_failure',
            data: { message: `Transport echoed ${authToken}` },
          });
          return { ok: false, error: { code: 'COMMAND_FAILED', message: 'transport failed' } };
        },
      },
    );

    assert.equal(result.code, 1);
    assert.equal(result.transportOptions[0]?.authToken, authToken);
    assert.doesNotMatch(JSON.stringify(result.calls), new RegExp(authToken));
    const payload = JSON.parse(result.stdout) as { error?: { logPath?: string } };
    assert.ok(payload.error?.logPath);
    const diagnostics = fs.readFileSync(payload.error.logPath, 'utf8');
    assert.doesNotMatch(diagnostics, new RegExp(authToken));
    assert.match(diagnostics, /Transport echoed \[REDACTED\]/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
