import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const provider = 'aws-device-farm';
export const args = [
  '--platform',
  'android',
  '--aws-project-arn',
  'arn:aws:devicefarm:us-west-2:123456789012:project/example-project',
  '--aws-device-arn',
  'arn:aws:devicefarm:us-west-2::device/example-device',
  '--aws-app-arn',
  'arn:aws:devicefarm:us-west-2:123456789012:upload/example-upload',
];

const RESOURCES = {
  'get-project': { project: { arn: 'project', name: 'Agent Device' } },
  'get-device': {
    device: {
      arn: 'device',
      name: 'Google Pixel 8',
      platform: 'ANDROID',
      os: '14',
      availability: 'HIGHLY_AVAILABLE',
    },
  },
  'get-upload': {
    upload: {
      arn: 'upload',
      name: 'sample.apk',
      type: 'ANDROID_APP',
      status: 'SUCCEEDED',
    },
  },
};

// The AWS CLI is the plugin's only external call, so the fixture answers it from PATH. It has no
// credentials of its own to reject, so `connect` must pass on its first try.
export function environment(endpoint) {
  void endpoint;
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-aws-fixture-'));
  const script = [
    '#!/usr/bin/env node',
    `const resources = ${JSON.stringify(RESOURCES)};`,
    'const subcommand = process.argv[3];',
    'const result = resources[subcommand];',
    'if (!result) {',
    '  process.stderr.write(`unexpected aws devicefarm ${subcommand}\\n`);',
    '  process.exit(1);',
    '}',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'aws'), script, 'utf8');
  fs.chmodSync(path.join(bin, 'aws'), 0o755);
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
}
