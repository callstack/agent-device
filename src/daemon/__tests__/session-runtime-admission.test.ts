import { resolveSnapshotRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import { expect, test } from 'vitest';
import { ANDROID_EMULATOR, IOS_SIMULATOR } from '../../__tests__/test-utils/device-fixtures.ts';
import { snapshotRuntimeFixture } from './snapshot-runtime-fixture.ts';
import {
  admitRuntimePlan,
  unwrapAdmittedRuntimePlan,
  type AdmittedRuntimePlan,
} from '../session-runtime-admission.ts';

const { inspectFacts } = snapshotRuntimeFixture();

test('admits the plan whose required operations the owner facts report available', async () => {
  const plan = resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true });
  const admission = await admitRuntimePlan({ device: IOS_SIMULATOR, plan, inspectFacts });
  expect(admission.admitted).toBe(true);
  if (!admission.admitted) throw new Error('unreachable');
  // The payload is the very plan and the device the facts were read for (a frozen copy of the
  // device, so the caller's own DeviceInfo cannot move the admitted identity later).
  const payload = unwrapAdmittedRuntimePlan(admission);
  expect(payload.plan).toBe(plan);
  expect(payload.device).toEqual(IOS_SIMULATOR);
  expect(Object.isFrozen(payload.device)).toBe(true);
});

test('refuses on the first required operation the owner facts report unavailable', async () => {
  const plan = resolveSnapshotRuntimePlan({ customActions: true, hasActiveApp: true });
  const admission = await admitRuntimePlan({ device: ANDROID_EMULATOR, plan, inspectFacts });
  expect(admission).toMatchObject({
    admitted: false,
    operation: 'captureSnapshotWithCustomActions',
    fact: { available: false, reason: 'unsupported-platform-leaf' },
  });
});

test('throws when no facts inspection seam was supplied', async () => {
  const plan = resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true });
  await expect(admitRuntimePlan({ device: IOS_SIMULATOR, plan })).rejects.toThrow(
    'Device runtime facts inspection is unavailable.',
  );
});

test('the admission cannot be written down or copied: only admitRuntimePlan mints it', async () => {
  const plan = resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true });
  const admission = await admitRuntimePlan({ device: IOS_SIMULATOR, plan, inspectFacts });
  if (!admission.admitted) throw new Error('unreachable');
  // Planted reds for the seam itself: each directive below becomes unused — and tsc fails — if
  // the token loses its #private member (degrades to a plain shape). A route holds a token only
  // by having called admitRuntimePlan (or by a type assertion, which the cutover gate rejects in
  // src/daemon/). The class value is not exported, so `new` is not even nameable from here.
  // @ts-expect-error a literal is not an admission: it lacks the #private member
  const literal: AdmittedRuntimePlan<typeof plan> = { admitted: true };
  // @ts-expect-error a spread of a real admission is a plain object without the #private member
  const retargeted: AdmittedRuntimePlan<typeof plan> = { ...admission };
  expect([literal, retargeted].length).toBe(2);
});

test('the payload is reachable only by exact token identity: a Proxy, a spread, or a look-alike is refused', async () => {
  const plan = resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true });
  const admission = await admitRuntimePlan({ device: IOS_SIMULATOR, plan, inspectFacts });
  if (!admission.admitted) throw new Error('unreachable');
  // A Proxy around a real token types as the token without any assertion (the finding), and
  // could trap any public getter — which is why the token exposes none and the binder unwraps
  // through the identity-keyed store instead. The Proxy is a different identity: refused.
  const proxied: AdmittedRuntimePlan<typeof plan> = new Proxy(admission, {
    get: (target, property, receiver) =>
      property === 'device' ? ANDROID_EMULATOR : Reflect.get(target, property, receiver),
  });
  expect(() => unwrapAdmittedRuntimePlan(proxied)).toThrow(/not one minted by admitRuntimePlan/);
  // The token's own surface has nothing to retarget: no device/plan getters, frozen, no own keys.
  expect(Object.keys({ ...admission })).toEqual([]);
  expect(() => Object.defineProperty(admission, 'device', { value: ANDROID_EMULATOR })).toThrow(
    TypeError,
  );
  // And the real token still unwraps to what was admitted.
  expect(unwrapAdmittedRuntimePlan(admission).device).toEqual(IOS_SIMULATOR);
});

test('mutating the caller’s DeviceInfo after admission does not move the admitted device', async () => {
  const plan = resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true });
  const mutable = { ...IOS_SIMULATOR };
  const admission = await admitRuntimePlan({ device: mutable, plan, inspectFacts });
  if (!admission.admitted) throw new Error('unreachable');
  mutable.id = 'someone-else';
  expect(unwrapAdmittedRuntimePlan(admission).device.id).toBe(IOS_SIMULATOR.id);
});
