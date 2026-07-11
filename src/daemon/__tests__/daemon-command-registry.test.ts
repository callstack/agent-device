import assert from 'node:assert/strict';
import { test } from 'vitest';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import {
  canOverrideLockPolicySelector,
  canRunReplayScopedAction,
  getDaemonCommandRoute,
  getSessionCommandKind,
  isLeaseAdmissionExempt,
  shouldBlockForInvalidRecording,
  shouldGuardAndroidBlockingDialog,
  shouldLockSessionExecution,
  shouldPreferExplicitDeviceOverExistingSession,
  shouldValidateSessionSelector,
  resolveProviderDeviceResolutionIntent,
  usesSessionlessDefaultProviderDevice,
} from '../daemon-command-registry.ts';
import type { DaemonRequest } from '../types.ts';

test('daemon command registry owns specialized handler routes', () => {
  for (const command of [
    INTERNAL_COMMANDS.leaseAllocate,
    INTERNAL_COMMANDS.leaseHeartbeat,
    INTERNAL_COMMANDS.leaseRelease,
  ]) {
    assert.equal(getDaemonCommandRoute(command), 'lease', `${command} lease route`);
  }
  for (const command of [
    PUBLIC_COMMANDS.alert,
    PUBLIC_COMMANDS.diff,
    PUBLIC_COMMANDS.settings,
    PUBLIC_COMMANDS.snapshot,
    PUBLIC_COMMANDS.wait,
  ]) {
    assert.equal(getDaemonCommandRoute(command), 'snapshot', `${command} snapshot route`);
  }
  assert.equal(getDaemonCommandRoute(PUBLIC_COMMANDS.back), 'generic');
});

test('daemon command registry owns session handler subroutes', () => {
  assert.equal(getSessionCommandKind(INTERNAL_COMMANDS.sessionList), 'inventory');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.devices), 'inventory');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.capabilities), 'inventory');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.doctor), 'inventory');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.apps), 'inventory');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.boot), 'state');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.shutdown), 'state');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.appState), 'state');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.audio), 'observability');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.logs), 'observability');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.test), 'replay');
  assert.equal(getSessionCommandKind(PUBLIC_COMMANDS.open), undefined);
});

test('daemon command registry preserves request admission traits', () => {
  for (const command of [
    INTERNAL_COMMANDS.sessionList,
    PUBLIC_COMMANDS.capabilities,
    PUBLIC_COMMANDS.devices,
    PUBLIC_COMMANDS.doctor,
    INTERNAL_COMMANDS.releaseMaterializedPaths,
    INTERNAL_COMMANDS.leaseAllocate,
    INTERNAL_COMMANDS.leaseHeartbeat,
    INTERNAL_COMMANDS.leaseRelease,
  ]) {
    assert.equal(isLeaseAdmissionExempt(command), true, `${command} lease admission`);
    assert.equal(shouldLockSessionExecution(command), false, `${command} lock`);
  }

  for (const command of [
    INTERNAL_COMMANDS.sessionList,
    PUBLIC_COMMANDS.capabilities,
    PUBLIC_COMMANDS.devices,
    PUBLIC_COMMANDS.doctor,
    INTERNAL_COMMANDS.releaseMaterializedPaths,
  ]) {
    assert.equal(shouldValidateSessionSelector(command), false, `${command} selector`);
  }

  assert.equal(shouldValidateSessionSelector(INTERNAL_COMMANDS.leaseAllocate), true);
  assert.equal(isLeaseAdmissionExempt(PUBLIC_COMMANDS.open), false);
  assert.equal(shouldLockSessionExecution(PUBLIC_COMMANDS.open), true);
});

test('daemon command registry preserves replay and recording traits', () => {
  for (const command of [
    PUBLIC_COMMANDS.alert,
    PUBLIC_COMMANDS.back,
    PUBLIC_COMMANDS.click,
    PUBLIC_COMMANDS.clipboard,
    PUBLIC_COMMANDS.diff,
    PUBLIC_COMMANDS.fill,
    PUBLIC_COMMANDS.find,
    PUBLIC_COMMANDS.gesture,
    PUBLIC_COMMANDS.get,
    PUBLIC_COMMANDS.home,
    PUBLIC_COMMANDS.is,
    PUBLIC_COMMANDS.keyboard,
    PUBLIC_COMMANDS.longPress,
    PUBLIC_COMMANDS.press,
    PUBLIC_COMMANDS.record,
    PUBLIC_COMMANDS.reactNative,
    PUBLIC_COMMANDS.rotate,
    PUBLIC_COMMANDS.screenshot,
    PUBLIC_COMMANDS.scroll,
    PUBLIC_COMMANDS.settings,
    PUBLIC_COMMANDS.snapshot,
    PUBLIC_COMMANDS.swipe,
    PUBLIC_COMMANDS.type,
    PUBLIC_COMMANDS.wait,
  ]) {
    assert.equal(canRunReplayScopedAction(command), true, `${command} replay scope`);
  }

  assert.equal(canRunReplayScopedAction(PUBLIC_COMMANDS.focus), false);
  assert.equal(shouldBlockForInvalidRecording(PUBLIC_COMMANDS.record), false);
  assert.equal(shouldBlockForInvalidRecording(PUBLIC_COMMANDS.close), false);
  assert.equal(shouldBlockForInvalidRecording(PUBLIC_COMMANDS.snapshot), true);
});

test('daemon command registry preserves Android modal and lock-policy traits', () => {
  for (const command of [
    PUBLIC_COMMANDS.back,
    PUBLIC_COMMANDS.click,
    PUBLIC_COMMANDS.fill,
    PUBLIC_COMMANDS.focus,
    PUBLIC_COMMANDS.gesture,
    PUBLIC_COMMANDS.home,
    PUBLIC_COMMANDS.keyboard,
    PUBLIC_COMMANDS.longPress,
    PUBLIC_COMMANDS.press,
    PUBLIC_COMMANDS.rotate,
    PUBLIC_COMMANDS.scroll,
    PUBLIC_COMMANDS.swipe,
    PUBLIC_COMMANDS.type,
  ]) {
    assert.equal(shouldGuardAndroidBlockingDialog(command), true, `${command} Android guard`);
  }

  assert.equal(shouldGuardAndroidBlockingDialog(PUBLIC_COMMANDS.get), false);
  assert.equal(canOverrideLockPolicySelector(PUBLIC_COMMANDS.apps), true);
  assert.equal(canOverrideLockPolicySelector(PUBLIC_COMMANDS.capabilities), true);
  assert.equal(canOverrideLockPolicySelector(PUBLIC_COMMANDS.devices), true);
  assert.equal(canOverrideLockPolicySelector(PUBLIC_COMMANDS.doctor), true);
  assert.equal(canOverrideLockPolicySelector(PUBLIC_COMMANDS.open), false);
});

test('daemon command registry preserves provider device resolution traits', () => {
  assert.equal(
    shouldPreferExplicitDeviceOverExistingSession(makeRequest(PUBLIC_COMMANDS.apps)),
    true,
  );
  assert.equal(
    shouldPreferExplicitDeviceOverExistingSession(makeRequest(PUBLIC_COMMANDS.capabilities)),
    true,
  );
  assert.equal(
    shouldPreferExplicitDeviceOverExistingSession(makeRequest(PUBLIC_COMMANDS.snapshot)),
    false,
  );
  assert.equal(usesSessionlessDefaultProviderDevice(makeRequest(PUBLIC_COMMANDS.open)), true);
  assert.equal(usesSessionlessDefaultProviderDevice(makeRequest(PUBLIC_COMMANDS.doctor)), true);
  assert.equal(
    usesSessionlessDefaultProviderDevice(makeRequest(PUBLIC_COMMANDS.record, ['start'])),
    true,
  );
  assert.equal(
    usesSessionlessDefaultProviderDevice(makeRequest(PUBLIC_COMMANDS.record, ['stop'])),
    false,
  );
  assert.equal(
    resolveProviderDeviceResolutionIntent(makeRequest(PUBLIC_COMMANDS.test), {
      hasExistingSession: false,
      hasExplicitDeviceSelector: false,
    }),
    'skip',
  );
  assert.equal(
    resolveProviderDeviceResolutionIntent(
      {
        ...makeRequest(PUBLIC_COMMANDS.test),
        flags: { shardAll: 2 },
      },
      {
        hasExistingSession: false,
        hasExplicitDeviceSelector: true,
      },
    ),
    'skip',
  );
  assert.equal(
    resolveProviderDeviceResolutionIntent(makeRequest(PUBLIC_COMMANDS.open), {
      hasExistingSession: false,
      hasExplicitDeviceSelector: false,
    }),
    'sessionless-default-device',
  );
  assert.equal(
    resolveProviderDeviceResolutionIntent(makeRequest(PUBLIC_COMMANDS.apps), {
      hasExistingSession: true,
      hasExplicitDeviceSelector: true,
    }),
    'explicit-device',
  );
});

function makeRequest(command: string, positionals: string[] = []): DaemonRequest {
  return {
    command,
    token: 'test-token',
    session: 'registry-test',
    positionals,
    flags: {},
  };
}
