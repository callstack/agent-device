import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';
import { DAEMON_POLICY_ENV, loadDaemonPolicy, parseDaemonPolicy } from '../daemon-policy-file.ts';

const SOURCE = '/etc/agent-device/policy.json';

test('no configured policy leaves the daemon unrestricted', () => {
  expect(loadDaemonPolicy({})).toBeUndefined();
});

test('a policy file that cannot be read or parsed fails loading', () => {
  const dir = mkdtempForTestSync('agent-device-daemon-policy-load-');
  const policyPath = path.join(dir, 'policy.json');
  fs.writeFileSync(policyPath, '{ not json');

  expect(() => loadDaemonPolicy({ [DAEMON_POLICY_ENV]: policyPath })).toThrow(
    /Invalid daemon policy/,
  );
  expect(() => loadDaemonPolicy({ [DAEMON_POLICY_ENV]: path.join(dir, 'missing.json') })).toThrow(
    /cannot read policy JSON/,
  );
});

test.each([
  [{ version: 2 }, /"version" must be 1/],
  [{ version: 1, extra: true }, /unknown key "extra"/],
  [{ version: 1, commands: { allow: ['open'], deny: ['close'] } }, /exactly one of "allow"/],
  [{ version: 1, commands: { deny: ['reboot-host'] } }, /unknown command "reboot-host"/],
  [{ version: 1, devices: { allow: [] } }, /must not be empty/],
  [{ version: 1, devices: { allow: [{ udid: 'a', serial: 'b' }] } }, /exactly one "udid"/],
  [{ version: 1, capabilities: { deny: ['device-erase'] } }, /unknown capability "device-erase"/],
])('rejects an invalid policy %j', (raw, message) => {
  expect(() => parseDaemonPolicy(raw, SOURCE)).toThrow(message);
});

test('the digest names the rules, not their order or source path', () => {
  const first = parseDaemonPolicy(
    {
      version: 1,
      devices: { allow: [{ udid: 'a' }, { serial: 'b' }] },
      commands: { deny: ['boot', 'shutdown'] },
    },
    SOURCE,
  );
  const reordered = parseDaemonPolicy(
    {
      version: 1,
      commands: { deny: ['shutdown', 'boot'] },
      devices: { allow: [{ serial: 'b' }, { udid: 'a' }] },
    },
    '/elsewhere/policy.json',
  );
  const different = parseDaemonPolicy({ version: 1, commands: { deny: ['boot'] } }, SOURCE);

  expect(reordered.digest).toBe(first.digest);
  expect(different.digest).not.toBe(first.digest);
});
