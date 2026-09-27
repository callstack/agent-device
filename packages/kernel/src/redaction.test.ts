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
    launchEnvironment: '[REDACTED]',
    launchEnvironmentEntries: '[REDACTED]',
    safe: 'visible',
  });
  expect(JSON.stringify(redacted)).not.toContain('secret-value');
});
