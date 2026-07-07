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
  buildAgentCdpPassthroughArgs,
  runAgentCdpCommand,
} from '../cli/commands/agent-cdp.ts';

afterEach(() => {
  vi.clearAllMocks();
});

test('cdp wrapper pins agent-cdp package version', () => {
  assert.equal(AGENT_CDP_PACKAGE, 'agent-cdp@1.6.1');
  assert.deepEqual(
    buildAgentCdpNpmExecArgs(['memory', 'usage', 'sample', '--label', 'baseline', '--gc']),
    [
      'exec',
      '--yes',
      '--package',
      'agent-cdp@1.6.1',
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
    'agent-cdp@1.6.1',
    '--',
    'agent-cdp',
    'target',
    'list',
  ]);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.cwd, '/tmp/project');
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.env, env);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.allowFailure, true);
});

test('cdp injects remote React Native dev-server public url for target discovery', async () => {
  const args = buildAgentCdpPassthroughArgs(['target', 'list'], {
    flags: {
      leaseBackend: 'android-instance',
      metroProxyBaseUrl: 'https://bridge.example.test',
      metroPublicBaseUrl: 'http://127.0.0.1:8081/',
    },
    runtime: {
      platform: 'android',
      bundleUrl:
        'https://bridge.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android&dev=true',
    },
  });

  assert.deepEqual(args, ['target', 'list', '--url', 'http://127.0.0.1:8081']);
});

test('cdp preserves explicit target url for remote sessions', () => {
  const args = buildAgentCdpPassthroughArgs(
    ['target', 'select', 'react-native:a:b', '--url', 'https://custom.example.test'],
    {
      flags: {
        leaseBackend: 'ios-instance',
        metroProxyBaseUrl: 'https://bridge.example.test',
      },
      runtime: {
        platform: 'ios',
        bundleUrl: 'https://bridge.example.test/api/metro/runtimes/runtime-1/index.bundle',
      },
    },
  );

  assert.deepEqual(args, [
    'target',
    'select',
    'react-native:a:b',
    '--url',
    'https://custom.example.test',
  ]);
});

test('cdp rejects remote bridge target discovery without React Native dev-server public url', () => {
  assert.throws(
    () =>
      buildAgentCdpPassthroughArgs(['target', 'list'], {
        flags: {
          leaseBackend: 'android-instance',
          metroProxyBaseUrl: 'https://bridge.example.test',
        },
        runtime: {
          platform: 'android',
          bundleUrl:
            'https://bridge.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android&dev=true',
        },
      }),
    /cdp remote bridge target discovery requires a React Native dev-server public base URL/,
  );
});

test('cdp passes injected remote target url to npm exec', async () => {
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  const exitCode = await runAgentCdpCommand(['target', 'list'], {
    flags: {
      leaseBackend: 'ios-instance',
      metroProxyBaseUrl: 'https://bridge.example.test',
      metroPublicBaseUrl: 'http://127.0.0.1:8081',
    },
    runtime: {
      platform: 'ios',
      bundleUrl: 'https://bridge.example.test/api/metro/runtimes/runtime-2/index.bundle',
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(vi.mocked(runCmdStreaming).mock.calls[0]?.[1], [
    'exec',
    '--yes',
    '--package',
    'agent-cdp@1.6.1',
    '--',
    'agent-cdp',
    'target',
    'list',
    '--url',
    'http://127.0.0.1:8081',
  ]);
});
