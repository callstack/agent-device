import fs from 'node:fs';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';

vi.mock('../utils/exec.ts', () => ({
  runCmdStreaming: vi.fn(),
}));

import { runCmdStreaming } from '../utils/exec.ts';
import {
  AGENT_CDP_PACKAGE,
  buildAgentCdpNpmExecArgs,
  runAgentCdpCommand,
} from '../cli/commands/agent-cdp.ts';

afterEach(() => {
  vi.clearAllMocks();
});

test('cdp wrapper pins agent-cdp package version', () => {
  assert.equal(AGENT_CDP_PACKAGE, 'agent-cdp@1.6.0');
  assert.deepEqual(
    buildAgentCdpNpmExecArgs(['memory', 'usage', 'sample', '--label', 'baseline', '--gc']),
    [
      'exec',
      '--yes',
      '--package',
      'agent-cdp@1.6.0',
      '--',
      'agent-cdp',
      'memory',
      'usage',
      'sample',
      '--label',
      'baseline',
      '--gc',
    ],
  );
});

test('cdp docs hide the implementation package name', () => {
  assert.doesNotMatch(fs.readFileSync('website/docs/docs/commands.md', 'utf8'), /agent-cdp/);
  assert.doesNotMatch(
    fs.readFileSync('website/docs/docs/debugging-profiling.md', 'utf8'),
    /agent-cdp/,
  );
});

test('cdp workflow docs live in debugging and profiling guide', () => {
  assert.match(
    fs.readFileSync('website/docs/docs/commands.md', 'utf8'),
    /agent-device cdp memory usage sample --label baseline --gc/,
  );
  assert.doesNotMatch(
    fs.readFileSync('website/docs/docs/commands.md', 'utf8'),
    /React Native JS memory through CDP/,
  );
  assert.match(
    fs.readFileSync('website/docs/docs/debugging-profiling.md', 'utf8'),
    /React Native JS memory through CDP/,
  );
});

test('cdp wrapper streams through npm exec and returns downstream exit code', async () => {
  const env = { ...process.env };
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 7,
    stdout: '',
    stderr: '',
  });

  const exitCode = await runAgentCdpCommand(['target', 'list'], {
    cwd: '/tmp/project',
    env,
  });

  assert.equal(exitCode, 7);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[0], 'npm');
  assert.deepEqual(vi.mocked(runCmdStreaming).mock.calls[0]?.[1], [
    'exec',
    '--yes',
    '--package',
    'agent-cdp@1.6.0',
    '--',
    'agent-cdp',
    'target',
    'list',
  ]);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.cwd, '/tmp/project');
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.env, env);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.allowFailure, true);
});
