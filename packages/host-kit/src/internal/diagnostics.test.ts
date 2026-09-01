import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  registerDiagnosticSensitiveValue,
  withDiagnosticsScope,
} from './diagnostics.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

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

test('overlapping sensitive values replace longest-first even when registered out of order', async () => {
  const outputPath = path.join(mkdtempForTestSync('agent-device-diag-overlap-'), 'request.ndjson');
  const shortLiteral = 'secret-value';
  const longLiteral = `${shortLiteral}-extended`;

  await withDiagnosticsScope({ command: 'fill', logPath: outputPath }, async () => {
    registerDiagnosticSensitiveValue(shortLiteral);
    registerDiagnosticSensitiveValue(longLiteral);
    emitDiagnostic({
      phase: 'platform_failure',
      data: { message: `echoed ${longLiteral} tail` },
    });
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(outputPath, 'utf8');
  assert.equal(diagnostics.includes(longLiteral), false);
  assert.equal(diagnostics.includes(shortLiteral), false);
  // Shortest-first replacement would leave '[REDACTED]-extended' behind.
  assert.match(diagnostics, /echoed \[REDACTED\] tail/);
});

test('a value registered after an emit but before flush is replaced in the flushed file', async () => {
  const outputPath = path.join(
    mkdtempForTestSync('agent-device-diag-late-register-'),
    'request.ndjson',
  );
  const lateSecret = 'late-registered-opaque-literal';

  await withDiagnosticsScope({ command: 'fill', logPath: outputPath }, async () => {
    emitDiagnostic({
      phase: 'platform_failure',
      data: { message: `captured ${lateSecret}` },
    });
    registerDiagnosticSensitiveValue(lateSecret);
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(outputPath, 'utf8');
  assert.equal(diagnostics.includes(lateSecret), false);
  assert.match(diagnostics, /captured \[REDACTED\]/);
});

test('appendDiagnosticLine ensures the log directory once across appended lines', () => {
  const logDir = mkdtempForTestSync('agent-device-diag-mkdir-');
  const logPath = path.join(logDir, 'nested', 'request.ndjson');
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
  try {
    withDiagnosticsScope({ command: 'fill', logPath, debug: true }, () => {
      for (let index = 0; index < 3; index += 1) {
        emitDiagnostic({ phase: `iteration_${index}`, data: { index } });
      }
    });

    const callsForLogDir = mkdirSpy.mock.calls.filter(([dir]) => dir === path.dirname(logPath));
    assert.equal(callsForLogDir.length, 1);
    assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 3);
  } finally {
    mkdirSpy.mockRestore();
  }
});

test('a later diagnostics scope recreates a removed log directory', async () => {
  const rootDir = mkdtempForTestSync('agent-device-diag-recreate-');
  const logDir = path.join(rootDir, 'nested');
  const logPath = path.join(logDir, 'request.ndjson');
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
  try {
    await withDiagnosticsScope({ command: 'first', logPath, debug: true }, () => {
      emitDiagnostic({ phase: 'first_scope' });
    });
    fs.rmSync(logDir, { recursive: true, force: true });

    await withDiagnosticsScope({ command: 'second', logPath, debug: true }, () => {
      emitDiagnostic({ phase: 'second_scope' });
    });

    const callsForLogDir = mkdirSpy.mock.calls.filter(([dir]) => dir === logDir);
    assert.equal(callsForLogDir.length, 2);
    assert.match(fs.readFileSync(logPath, 'utf8'), /second_scope/);
  } finally {
    mkdirSpy.mockRestore();
  }
});
