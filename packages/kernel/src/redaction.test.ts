import { expect, test } from 'vitest';
import { redactDiagnosticData } from './redaction.ts';

test('redacts launch environment maps and CLI entries from structured diagnostics', () => {
  const secret = 'https://example.com/private-clip?nonce=secret-value';
  const redacted = redactDiagnosticData({
    launchEnvironment: { _XCAppClipURL: secret },
    launchEnvironmentEntries: [`_XCAppClipURL=${secret}`],
    safe: 'visible',
  });

  expect(redacted).toEqual({
    launchEnvironment: { _XCAppClipURL: '[REDACTED]' },
    launchEnvironmentEntries: ['_XCAppClipURL=[REDACTED]'],
    safe: 'visible',
  });
  expect(JSON.stringify(redacted)).not.toContain('secret-value');
  expect(JSON.stringify(redacted)).toContain('_XCAppClipURL');
});

test('redacts launch environment values in command arguments and free-text diagnostics', () => {
  const secret = 'https://example.com/private-clip?nonce=secret-value';
  const redacted = redactDiagnosticData({
    argv: ['--launch-env', `_XCAppClipURL=${secret}`, `--launch-env=MODE=${secret}`],
    message: `invalid --launch-env _XCAppClipURL=${secret}`,
    environment: { SIMCTL_CHILD_MODE: 'private-mode' },
  });
  const serialized = JSON.stringify(redacted);

  expect(serialized).not.toContain('secret-value');
  expect(serialized).not.toContain('private-mode');
  expect(serialized).toContain('_XCAppClipURL');
  expect(serialized).toContain('SIMCTL_CHILD_MODE');
  expect(serialized).toContain('[REDACTED]');
});

test('redacts plain launch environment values without hiding unrelated assignments', () => {
  const redacted = redactDiagnosticData({
    argv: ['--launch-env', 'MODE=plain-secret'],
    message: '--launch-env requires KEY=VALUE. Example: PORT=8080 HOST=localhost',
  });

  expect(redacted).toEqual({
    argv: ['--launch-env', 'MODE=[REDACTED]'],
    message: '--launch-env requires KEY=VALUE. Example: PORT=8080 HOST=localhost',
  });
  expect(JSON.stringify(redacted)).not.toContain('plain-secret');
});
