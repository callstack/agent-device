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
import { acquireAllocatorHeldDeviceClaim } from '../device-claim-allocator.ts';
import { abandonDeviceClaim, acquireDeviceClaim } from '../device-claims.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from '../device-claim-paths.ts';
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

test('a transient-exclusive command executes under the allocator-held claim, acquires nothing and clears nothing', async () => {
  const { stateDir, claimsDir } = setup();
  await acquireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    principal: { stateDir, instanceId: 'sim-a', identityIncarnationId: 'incarnation-1' },
  });
  const [before] = fs
    .readdirSync(claimsDir)
    .map((name) => fs.readFileSync(path.join(claimsDir, name), 'utf8'));

  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');
  await admission.admit(ANDROID_EMULATOR, managedOwner, MANAGED_BINDING);
  await admission[Symbol.asyncDispose]();

  // One file, byte-identical: no transient claim was added and dispose removed nothing.
  const after = fs
    .readdirSync(claimsDir)
    .map((name) => fs.readFileSync(path.join(claimsDir, name), 'utf8'));
  expect(after).toEqual([before]);
  expect(claimedSessions()).toEqual([undefined]);
});

test('an allocator-held claim of another installation refuses the managed binding as DEVICE_CLAIM_ALLOCATOR_HELD', async () => {
  const { root, stateDir } = setup();
  await acquireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    principal: {
      stateDir: path.join(root, 'foreign-installation'),
      instanceId: 'sim-a',
      identityIncarnationId: 'incarnation-1',
    },
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');
  const error = asAppError(
    await admission
      .admit(ANDROID_EMULATOR, managedOwner, MANAGED_BINDING)
      .catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_ALLOCATOR_HELD');
  expect(error.details?.retriable).toBe(false);
  await admission[Symbol.asyncDispose]();
});

test('a managed binding fencing another identity incarnation is refused as stale, not covered', async () => {
  const { stateDir } = setup();
  await acquireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    principal: { stateDir, instanceId: 'sim-a', identityIncarnationId: 'incarnation-1' },
  });

  const admission = makeAdmission('transient-exclusive', stateDir, 'shutdown');
  const error = asAppError(
    await admission
      .admit(ANDROID_EMULATOR, managedOwner, {
        kind: 'exact-owner',
        owner: managedOwner,
        fence: managedBindingFence({
          requesterId: 'requester-1',
          requestGeneration: 2,
          identityIncarnationId: 'incarnation-2',
        }),
      })
      .catch((error: unknown) => error),
  );

  expect(error.code).toBe('COMMAND_FAILED');
  expect(error.details?.reason).toBe('allocator-claim-incarnation-stale');
  expect(error.details?.heldIncarnationId).toBe('incarnation-1');
  await admission[Symbol.asyncDispose]();
});

// An ordinary daemon must not reach a managed identity through an observe-policy command either:
// `apps` and `app-state` boot the device through `ensureReady` exactly as a mutation would.
test.for(POLICY_CLAIMS.map(([policy]) => policy).filter((policy) => policy !== 'none'))(
  'an ordinary owner is refused DEVICE_CLAIM_ALLOCATOR_HELD under the %s policy',
  async (policy, { expect }) => {
    const { stateDir, claimsDir } = setup();
    await acquireAllocatorHeldDeviceClaim({
      device: ANDROID_EMULATOR,
      principal: { stateDir, instanceId: 'sim-a', identityIncarnationId: 'incarnation-1' },
    });
    const before = fs.readdirSync(claimsDir);
    const admission = makeAdmission(policy, stateDir);

    const error = asAppError(
      await admission
        .admit(ANDROID_EMULATOR, localAndroid, ORDINARY)
        .catch((error: unknown) => error),
    );

    expect(error.code).toBe('DEVICE_IN_USE');
    expect(error.details?.reason).toBe('DEVICE_CLAIM_ALLOCATOR_HELD');
    await admission[Symbol.asyncDispose]();
    expect(fs.readdirSync(claimsDir)).toEqual(before);
  },
);

// A claim file corrupted into declaring both the allocator schema version and a process
// principal does not decode to either claim kind, but it is not provably a non-allocator
// record either: it must refuse ordinary admission, not fall through as if the device were free.
test('an ordinary owner is refused for a corrupted allocator-looking claim record, not waved through', async () => {
  const { stateDir, claimsDir } = setup();
  fs.mkdirSync(claimsDir, { recursive: true });
  const deviceKey = canonicalLocalDeviceKey(ANDROID_EMULATOR);
  fs.writeFileSync(
    resolveDeviceClaimPath(deviceKey),
    JSON.stringify({
      schemaVersion: 3,
      kind: 'allocator',
      deviceKey,
      device: {
        family: 'android',
        id: ANDROID_EMULATOR.id,
        name: ANDROID_EMULATOR.name,
        kind: ANDROID_EMULATOR.kind,
      },
      stateDir: '/state/host',
      allocator: { instanceId: 'sim-a', identityIncarnationId: 'inc-1' },
      // A process principal on an allocator record is exactly the corruption that must not
      // decode: decodeAllocatorHeldClaim refuses it, and this is the record that refusal leaves.
      ownerPid: 4242,
      createdAtMs: 1,
      updatedAtMs: 2,
    }),
  );
  const admission = makeAdmission('observe', stateDir);

  const error = asAppError(
    await admission
      .admit(ANDROID_EMULATOR, localAndroid, ORDINARY)
      .catch((error: unknown) => error),
  );

  expect(error.code).toBe('DEVICE_IN_USE');
  expect(error.details?.reason).toBe('DEVICE_CLAIM_OWNER_UNCERTAIN');
  expect(error.details?.classification).toBe('allocator-inconsistent');
  await admission[Symbol.asyncDispose]();
});

test('the none policy still reaches no device state at all', async () => {
  const { stateDir, claimsDir } = setup();
  await acquireAllocatorHeldDeviceClaim({
    device: ANDROID_EMULATOR,
    principal: { stateDir, instanceId: 'sim-a', identityIncarnationId: 'incarnation-1' },
  });
  const before = fs.readdirSync(claimsDir);

  const admission = makeAdmission('none', stateDir);
  await admission.admit(ANDROID_EMULATOR, localAndroid, ORDINARY);
  await admission[Symbol.asyncDispose]();

  expect(fs.readdirSync(claimsDir)).toEqual(before);
});

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
