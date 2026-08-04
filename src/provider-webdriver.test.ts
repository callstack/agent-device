import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { providerWebDriver } from './provider-webdriver.ts';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';

test('root provider facade runs AWS artifact lookup through the host command adapter', async () => {
  const tempDir = mkdtempForTestSync('agent-device-provider-webdriver-');
  const awsPath = path.join(tempDir, 'aws');
  const callsPath = path.join(tempDir, 'aws-calls.ndjson');
  const previousPath = process.env.PATH;
  const previousCallsPath = process.env.AGENT_DEVICE_TEST_AWS_CALLS_PATH;
  fs.writeFileSync(
    awsPath,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'fs.appendFileSync(process.env.AGENT_DEVICE_TEST_AWS_CALLS_PATH, `${JSON.stringify(process.argv.slice(2))}\\n`);',
      "process.stdout.write(JSON.stringify({ artifacts: [{ arn: 'artifact-1', name: 'video', type: 'VIDEO', url: 'https://aws.example/video.mp4' }] }));",
    ].join('\n'),
  );
  fs.chmodSync(awsPath, 0o755);
  process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ''}`;
  process.env.AGENT_DEVICE_TEST_AWS_CALLS_PATH = callsPath;

  try {
    const result = await providerWebDriver.listArtifactsFromEnv(
      {
        provider: 'aws-device-farm',
        providerSessionId: 'arn:aws:devicefarm:us-west-2:123:session/project/session/1',
      },
      { AWS_REGION: 'us-west-2' },
    );

    assert.equal(result?.provider, 'aws-device-farm');
    assert.equal(result?.status, 'ready');
    assert.deepEqual(
      result?.cloudArtifacts.map(({ kind, url }) => ({ kind, url })),
      [
        { kind: 'video', url: 'https://aws.example/video.mp4' },
        { kind: 'video', url: 'https://aws.example/video.mp4' },
      ],
    );
    const calls = fs
      .readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
      .sort((left, right) => (left[7] ?? '').localeCompare(right[7] ?? ''));
    assert.deepEqual(
      calls.map((args) => args.slice(0, 6)),
      [
        [
          'devicefarm',
          'list-artifacts',
          '--region',
          'us-west-2',
          '--arn',
          result?.providerSessionId,
        ],
        [
          'devicefarm',
          'list-artifacts',
          '--region',
          'us-west-2',
          '--arn',
          result?.providerSessionId,
        ],
      ],
    );
    assert.deepEqual(
      calls.map((args) => args.slice(6)),
      [
        ['--type', 'FILE', '--output', 'json'],
        ['--type', 'LOG', '--output', 'json'],
      ],
    );
  } finally {
    restoreEnv('PATH', previousPath);
    restoreEnv('AGENT_DEVICE_TEST_AWS_CALLS_PATH', previousCallsPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
