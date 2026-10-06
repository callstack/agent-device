import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { commandDescriptors } from '@agent-device/command-registry/registry';
import type { CommandDescriptor } from '@agent-device/command-registry/types';
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
  [{ version: 1, commands: { deny: ['lease_heartbeat'] } }, /unknown command "lease_heartbeat"/],
  [{ version: 1, commands: { deny: ['react-devtools'] } }, /runs in the client; name the daemon/],
  [{ version: 1, devices: { allow: [] } }, /must not be empty/],
  [{ version: 1, devices: { allow: [{ udid: 'a', serial: 'b' }] } }, /exactly one "udid"/],
  [{ version: 1, capabilities: { deny: ['device-erase'] } }, /unknown capability "device-erase"/],
  [{ version: 1, leases: { require: 'ios-instance' } }, /"leases.require" must be macos-app/],
  [{ version: 1, leases: { allow: ['macos-app'] } }, /unknown key "leases.allow"/],
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
  const base = { version: 1, devices: { allow: [{ udid: 'a' }] }, commands: { deny: ['boot'] } };
  const baseDigest = parseDaemonPolicy(base, SOURCE).digest;
  const variants = [
    { ...base, commands: { deny: ['boot', 'shutdown'] } },
    { ...base, devices: { allow: [{ udid: 'b' }] } },
    { ...base, capabilities: { deny: ['device-shutdown'] } },
    { ...base, leases: { require: 'macos-app' } },
  ];

  expect(reordered.digest).toBe(first.digest);
  for (const variant of variants) {
    expect(parseDaemonPolicy(variant, SOURCE).digest).not.toBe(baseDigest);
  }
});

test('a policy without lease rules keeps the digest it had before lease rules existed', () => {
  const canonical = JSON.stringify({ devices: null, commands: null, capabilities: [] });
  const expected = crypto.createHash('sha256').update(canonical).digest('hex');
  expect(parseDaemonPolicy({ version: 1 }, SOURCE).digest).toBe(expected);
  expect(parseDaemonPolicy({ version: 1, leases: { require: 'macos-app' } }, SOURCE)).toMatchObject(
    {
      requiredLeaseBackend: 'macos-app',
    },
  );
});

test('internal device commands are nameable by the public command they serve or by their own name', () => {
  expect(() =>
    parseDaemonPolicy(
      { version: 1, commands: { allow: ['runtime', 'install-from-source'] } },
      SOURCE,
    ),
  ).not.toThrow();
});

test('every servesPublicCommand names a public command', () => {
  const descriptors = commandDescriptors as readonly CommandDescriptor[];
  const publicNames = new Set(
    descriptors.filter((d) => d.catalog.group === 'public').map((d) => d.name),
  );
  const served = descriptors.flatMap((d) =>
    d.catalog.servesPublicCommand ? [d.catalog.servesPublicCommand] : [],
  );

  expect(served.length).toBeGreaterThan(0);
  for (const name of served) expect(publicNames.has(name)).toBe(true);
});
