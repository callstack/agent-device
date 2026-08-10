import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmd } from '../../src/utils/exec.ts';
import { PAYLOAD_MARKER } from './support/exit-payload.ts';

const SUPPORT_DIR = path.join(import.meta.dirname, 'support');
const FIXTURE_TIMEOUT_MS = 10_000;
const STUB_DAEMON_BASE_URL = 'https://agent-device-exit-flush.test/agent-device';

// Isolates the delivery guarantee from daemon lifecycle behavior. The fixture
// writes a large payload through a real piped subprocess without asserting
// that the unsafe alternative must truncate under a particular OS, Node
// version, pipe configuration, or scheduler interleaving.
test('exitAfterFlush (the #1596 fix) delivers the full write before the process exits', async () => {
  const { exitCode, stderr } = await runFixture('exit-after-flush.ts');
  assert.equal(exitCode, 1);
  assert.ok(
    stderr.includes(PAYLOAD_MARKER),
    'expected the full payload, including its trailing marker',
  );
});

test('the CLI success entrypoint flushes a complete JSON envelope before exit 0', async () => {
  const { exitCode, stdout } = await runFixture('exit-after-flush.ts', ['--success']);
  assert.equal(exitCode, 0);
  const envelope = JSON.parse(stdout) as { success?: boolean; data?: { payload?: string } };
  assert.equal(envelope.success, true);
  assert.equal(envelope.data?.payload?.endsWith(PAYLOAD_MARKER), true);
});

test('the real source CLI flushes a complete successful snapshot response before exit 0', async () => {
  const fetchFixtureUrl = pathToFileURL(path.join(SUPPORT_DIR, 'exit-after-flush.ts')).href;
  const result = await runCmd(
    process.execPath,
    [
      '--experimental-strip-types',
      'src/bin.ts',
      'snapshot',
      '--daemon-base-url',
      STUB_DAEMON_BASE_URL,
      '--daemon-auth-token',
      'test-daemon-token',
      '--json',
    ],
    {
      allowFailure: true,
      timeoutMs: FIXTURE_TIMEOUT_MS,
      env: {
        ...process.env,
        AGENT_DEVICE_TEST_PAYLOAD_MARKER: PAYLOAD_MARKER,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchFixtureUrl}`]
          .filter(Boolean)
          .join(' '),
      },
    },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const envelope = JSON.parse(result.stdout) as {
    success?: boolean;
    data?: { nodes?: Array<{ label?: string }> };
  };
  assert.equal(envelope.success, true);
  assert.equal(envelope.data?.nodes?.[0]?.label?.endsWith(PAYLOAD_MARKER), true);
});

async function runFixture(
  name: string,
  args: string[] = [],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCmd(
    process.execPath,
    ['--experimental-strip-types', path.join(SUPPORT_DIR, name), ...args],
    { allowFailure: true, timeoutMs: FIXTURE_TIMEOUT_MS },
  );
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
