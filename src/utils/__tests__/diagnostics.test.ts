import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  registerDiagnosticSensitiveValue,
  withDiagnosticsScope,
} from '../diagnostics.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

test('diagnostics redacts sensitive fields', async () => {
  const previousHome = process.env.HOME;
  const tempHome = mkdtempForTestSync('agent-device-diag-redact-');
  process.env.HOME = tempHome;
  try {
    const outputPath = await withDiagnosticsScope(
      {
        session: 'redaction-session',
        requestId: 'r2',
        command: 'fill',
      },
      async () => {
        emitDiagnostic({
          phase: 'request_failed',
          level: 'error',
          data: {
            token: 'secret-token',
            text: 'sensitive text',
            responseText:
              'access_token=oauth-access refresh_token:oauth-refresh password=https://secret.example/token',
            setupHint: 'Create a service/API token: https://bridge.agent-device.dev/api-keys',
            nested: { authorization: 'Bearer abc' },
            agentToken: 'adc_agent_secret',
            deviceUrl: 'https://cloud.agent-device.dev/device?user_code=ABCD-EFGH',
            userCode: 'ABCD-EFGH',
            safe: 'ok',
          },
        });
        return flushDiagnosticsToSessionFile({ force: true })?.path;
      },
    );

    assert.ok(outputPath);
    const rows = fs
      .readFileSync(outputPath as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const payload = rows[0]?.data ?? {};
    assert.equal(payload.token, '[REDACTED]');
    assert.equal(payload.text, 'sensitive text');
    assert.equal(
      payload.responseText,
      'access_token=[REDACTED] refresh_token:[REDACTED] password=[REDACTED]',
    );
    assert.equal(
      payload.setupHint,
      'Create a service/API token: https://bridge.agent-device.dev/api-keys',
    );
    assert.equal(payload.nested?.authorization, '[REDACTED]');
    assert.equal(payload.agentToken, '[REDACTED]');
    assert.equal(payload.deviceUrl, 'https://cloud.agent-device.dev/device?REDACTED');
    assert.equal(payload.userCode, '[REDACTED]');
    assert.equal(payload.safe, 'ok');
  } finally {
    process.env.HOME = previousHome;
  }
});

test('diagnostics scrubs caller-declared recorded input literals regardless of field name', async () => {
  const outputPath = path.join(
    mkdtempForTestSync('agent-device-diag-recorded-input-'),
    'request.ndjson',
  );
  const secret = 'opaque-value-without-sensitive-keywords';

  await withDiagnosticsScope({ command: 'fill', logPath: outputPath }, async () => {
    registerDiagnosticSensitiveValue(secret);
    emitDiagnostic({
      phase: 'platform_failure',
      data: { text: secret, message: `Backend echoed ${secret}` },
    });
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(outputPath, 'utf8');
  assert.equal(diagnostics.includes(secret), false);
  assert.match(diagnostics, /Backend echoed \[REDACTED\]/);
});
