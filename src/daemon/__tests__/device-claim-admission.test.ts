import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  localRuntimeOwner,
  managedBindingFence,
  managedLocalRuntimeOwner,
  providerRuntimeOwner,
  type DeviceBindingIntent,
} from '@agent-device/contracts/platform-runtime';
import { asAppError } from '@agent-device/kernel/errors';
import { ANDROID_EMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../__tests__/test-utils/device-claim-store.ts';
import { createDeviceClaimAdmission } from '../device-claim-admission.ts';
import { abandonDeviceClaim, acquireDeviceClaim } from '../device-claims.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { SessionStore } from '../session-store.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';
import type { DeviceClaimPolicy } from '../../core/command-descriptor/types.ts';

const setup = isolatedDeviceClaimStores('agent-device-claim-admission-');
const localAndroid = localRuntimeOwner('android');
const managedOwner = managedLocalRuntimeOwner('sim-a');
const ORDINARY: DeviceBindingIntent = { kind: 'ordinary' };
const MANAGED_BINDING: DeviceBindingIntent = {
  kind: 'exact-owner',
  owner: managedOwner,
  fence: managedBindingFence({
    requesterId: 'requester-1',
    requestGeneration: 1,
    identityIncarnationId: 'incarnation-1',
  }),
};

function makeAdmission(policy: DeviceClaimPolicy, stateDir: string, command = 'made-up-command') {
  return createDeviceClaimAdmission({
    policy,
    command,
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
}

function claimedSessions(): (string | undefined)[] {
  return inspectDeviceClaims({}).map((entry) => entry.claim?.session);
}

// Enforcement is a pure function of the declared policy, not of a command name:
// an unregistered command declared `transient-exclusive` claims, and every other
// policy stays out of the claim store entirely.
const POLICY_CLAIMS: [DeviceClaimPolicy, string[]][] = [
  ['none', []],
  ['observe', []],
  ['require-owner', []],
  ['acquire-session', []],
  ['release-session', []],
  ['transient-exclusive', ['transient:made-up-command']],
];

test.for(POLICY_CLAIMS)(
  'the %s policy reaches the claim store only when transient-exclusive',
  async ([policy, held], { expect }) => {
    const { stateDir, claimsDir } = setup();
    const admission = makeAdmission(policy, stateDir);

    await admission.admit(ANDROID_EMULATOR, localAndroid, ORDINARY);
    expect(claimedSessions()).toEqual(held);

    await admission[Symbol.asyncDispose]();
    expect(inspectDeviceClaims({})).toEqual([]);
    // A claim-free policy never even creates the store.
    if (held.length === 0) expect(fs.existsSync(claimsDir)).toBe(false);
  },
);

test('a foreign live claim refuses the command before it can reach device operations', async () => {
  const { root, stateDir } = setup();
  const ownerStateDir = path.join(root, 'foreign');
  fs.mkdirSync(ownerStateDir, { recursive: true });
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'owner-session',
    workspace: '/worktrees/foreign',
    stateDir: ownerStateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');
  const error = asAppError(
    await admission
      .admit(ANDROID_EMULATOR, localAndroid, ORDINARY)
      .catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_LIVE_OWNER');
  expect(error.details?.retriable).toBe(false);
  expect(error.details?.hint).toBe(
    'Inspect the owner with: agent-device device status --platform android --serial emulator-5554',
  );

  await admission[Symbol.asyncDispose]();
  // Disposal never touches a claim this command did not acquire.
  expect(claimedSessions()).toEqual(['owner-session']);
});

test('a claim already held by this daemon covers the command instead of colliding with it', async () => {
  const { stateDir } = setup();
  await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'open-session',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'install');
  await admission.admit(ANDROID_EMULATOR, localAndroid, ORDINARY);
  await admission[Symbol.asyncDispose]();

  // The session claim is untouched: the command neither replaced nor released it.
  expect(claimedSessions()).toEqual(['open-session']);
});

test("an abandoned claim becomes this command's own transient claim and is released", async () => {
  const { stateDir } = setup();
  const aborted = await acquireDeviceClaim({
    device: ANDROID_EMULATOR,
    session: 'aborted-open',
    workspace: '/worktrees/current',
    stateDir,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  expect(aborted.status).toBe('acquired');
  if (aborted.status !== 'acquired') return;
  expect(await abandonDeviceClaim(aborted.ownership)).toBe('abandoned');

  const admission = makeAdmission('transient-exclusive', stateDir, 'install');
  await admission.admit(ANDROID_EMULATOR, localAndroid, ORDINARY);

  // Coverage would have left the abandoned record owning the device with nothing to release it.
  expect(claimedSessions()).toEqual(['transient:install']);
  await admission[Symbol.asyncDispose]();
  expect(inspectDeviceClaims({})).toEqual([]);
});

test('a provider-owned device takes no host-local claim', async () => {
  const { stateDir, claimsDir } = setup();
  const admission = makeAdmission('transient-exclusive', stateDir);

  await admission.admit(ANDROID_EMULATOR, providerRuntimeOwner('limrun', 'instance-1'), ORDINARY);
  await admission[Symbol.asyncDispose]();

  expect(fs.existsSync(claimsDir)).toBe(false);
});

test('a managed local owner is refused allocator-claim-missing under a managed binding fence and never takes a transient claim', async () => {
  const { stateDir, claimsDir } = setup();
  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');

  const error = asAppError(
    await admission
      .admit(ANDROID_EMULATOR, managedOwner, MANAGED_BINDING)
      .catch((error: unknown) => error),
  );

  expect(error.code).toBe('COMMAND_FAILED');
  expect(error.details?.reason).toBe('allocator-claim-missing');
  expect(error.details?.retriable).toBe(false);
  expect(error.details?.owner).toBe('managed:["sim-a"]');
  expect(error.details?.hint).toMatch(/allocator-held claim/);
  // The verifier never reaches for the store: nothing to acquire, nothing to give back.
  expect(fs.existsSync(claimsDir)).toBe(false);
  await admission[Symbol.asyncDispose]();
  expect(fs.existsSync(claimsDir)).toBe(false);
});

test('a managed local owner bound without a managed binding fence is refused as a contract violation', async () => {
  const { stateDir, claimsDir } = setup();
  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');

  const error = asAppError(
    await admission
      .admit(ANDROID_EMULATOR, managedOwner, ORDINARY)
      .catch((error: unknown) => error),
  );

  expect(error.code).toBe('COMMAND_FAILED');
  expect(error.details?.reason).toBe('runtime-contract-invalid');
  expect(fs.existsSync(claimsDir)).toBe(false);
  await admission[Symbol.asyncDispose]();
});

// The rule is evaluated under every policy: the ordinary arm alone reads the policy (the
// POLICY_CLAIMS table above), while a managed local owner is verified even where an ordinary
// owner would never touch the store, and a provider owner never is.
test.for(POLICY_CLAIMS.map(([policy]) => policy))(
  'the device-claim rule is evaluated under the %s policy: managed local owners are verified, provider owners never claim',
  async (policy, { expect }) => {
    const { stateDir, claimsDir } = setup();
    const admission = makeAdmission(policy, stateDir);

    const error = asAppError(
      await admission
        .admit(ANDROID_EMULATOR, managedOwner, MANAGED_BINDING)
        .catch((error: unknown) => error),
    );
    expect(error.code).toBe('COMMAND_FAILED');
    expect(error.details?.reason).toBe('allocator-claim-missing');

    await admission.admit(ANDROID_EMULATOR, providerRuntimeOwner('limrun', 'instance-1'), ORDINARY);
    await admission[Symbol.asyncDispose]();
    expect(fs.existsSync(claimsDir)).toBe(false);
  },
);

/** Claims visible while one command holds a device binding from the real request scope. */
async function claimsWhileBound(command: string, stateDir: string) {
  const scope = await createRequestExecutionScope({
    req: { token: 't', session: 'default', command, positionals: [], flags: {} },
    sessionStore: new SessionStore(path.join(stateDir, 'sessions')),
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: unavailableDeviceRuntimeGateway,
    platformRequestScope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  try {
    await scope.bindDevice(ANDROID_EMULATOR, {
      required: [],
      preferred: [],
    });
    return claimedSessions();
  } finally {
    await scope[Symbol.asyncDispose]();
  }
}

test('the request scope claims only for commands whose descriptor declares transient-exclusive', async () => {
  const { stateDir } = setup();

  // Same binding call, same device: the difference is the descriptor policy.
  expect(await claimsWhileBound('shutdown', stateDir)).toEqual(['transient:shutdown']);
  expect(await claimsWhileBound('snapshot', stateDir)).toEqual([]);
  expect(inspectDeviceClaims({})).toEqual([]);
});
