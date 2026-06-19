import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isCommandSupportedOnDevice, unsupportedHintForDevice } from '../capabilities.ts';
import { matchesPlatformSelector, type DeviceInfo } from '../../utils/device.ts';
import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/index.ts';

const iosSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'sim-1',
  name: 'iPhone',
  kind: 'simulator',
};

const iosDevice: DeviceInfo = {
  platform: 'ios',
  id: 'dev-1',
  name: 'iPhone',
  kind: 'device',
};

const androidDevice: DeviceInfo = {
  platform: 'android',
  id: 'and-1',
  name: 'Pixel',
  kind: 'device',
};

const androidEmulator: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
};

const macOsDevice: DeviceInfo = {
  platform: 'macos',
  id: 'mac-1',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
};

const linuxDevice: DeviceInfo = {
  platform: 'linux',
  id: 'local',
  name: 'Linux Desktop',
  kind: 'device',
  target: 'desktop',
};

const webDevice = WEB_DESKTOP_DEVICE;

const tvOsSimulator: DeviceInfo = {
  platform: 'ios',
  id: 'tv-sim-1',
  name: 'Apple TV',
  kind: 'simulator',
  target: 'tv',
};

type SupportCheck = {
  device: DeviceInfo;
  expected: boolean;
  label: string;
};

function assertCommandSupport(commands: string[], checks: SupportCheck[]): void {
  for (const command of commands) {
    for (const check of checks) {
      assert.equal(
        isCommandSupportedOnDevice(command, check.device),
        check.expected,
        `${command} ${check.label}`,
      );
    }
  }
}

test('device capability matrix stays consistent across shared command groups', () => {
  const scenarios: Array<{ commands: string[]; checks: SupportCheck[] }> = [
    {
      commands: ['pinch'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: false, label: 'on macOS' },
        { device: tvOsSimulator, expected: false, label: 'on tvOS simulator' },
      ],
    },
    {
      commands: ['alert'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: true, label: 'on macOS' },
      ],
    },
    {
      commands: ['settings', 'clipboard'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: true, label: 'on macOS' },
      ],
    },
    {
      commands: ['push'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: false, label: 'on macOS' },
      ],
    },
    {
      commands: ['keyboard'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: true, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
      ],
    },
    {
      commands: ['shutdown'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidEmulator, expected: true, label: 'on Android emulator' },
        { device: androidDevice, expected: false, label: 'on Android device' },
        { device: macOsDevice, expected: false, label: 'on macOS' },
        { device: tvOsSimulator, expected: true, label: 'on tvOS simulator' },
      ],
    },
    {
      commands: ['reinstall', 'install'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: true, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: false, label: 'on macOS' },
      ],
    },
    {
      commands: ['swipe'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: true, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: true, label: 'on macOS' },
      ],
    },
    {
      commands: ['pan'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: true, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: true, label: 'on macOS' },
        { device: linuxDevice, expected: true, label: 'on Linux' },
      ],
    },
    {
      commands: ['fling'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: true, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: true, label: 'on macOS' },
        { device: linuxDevice, expected: false, label: 'on Linux' },
      ],
    },
    {
      commands: ['rotate-gesture'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: false, label: 'on macOS' },
        { device: tvOsSimulator, expected: false, label: 'on tvOS simulator' },
      ],
    },
    {
      commands: ['transform-gesture'],
      checks: [
        { device: iosSimulator, expected: true, label: 'on iOS sim' },
        { device: iosDevice, expected: false, label: 'on iOS device' },
        { device: androidDevice, expected: true, label: 'on Android' },
        { device: macOsDevice, expected: false, label: 'on macOS' },
        { device: tvOsSimulator, expected: false, label: 'on tvOS simulator' },
      ],
    },
  ];

  for (const scenario of scenarios) {
    assertCommandSupport(scenario.commands, scenario.checks);
  }
});

test('core commands support iOS simulator, iOS device, and Android', () => {
  assertCommandSupport(
    [
      'app-switcher',
      'apps',
      'back',
      'boot',
      'click',
      'close',
      'diff',
      'fill',
      'find',
      'focus',
      'get',
      'home',
      'install',
      'longpress',
      'logs',
      'open',
      'perf',
      'press',
      'record',
      'rotate',
      'screenshot',
      'scroll',
      'snapshot',
      'trigger-app-event',
      'type',
      'wait',
    ],
    [
      { device: iosSimulator, expected: true, label: 'on iOS sim' },
      { device: iosDevice, expected: true, label: 'on iOS device' },
      { device: androidDevice, expected: true, label: 'on Android' },
    ],
  );
});

test('macOS supports the Apple runner interaction core but excludes mobile-only commands', () => {
  assertCommandSupport(
    [
      'alert',
      'apps',
      'back',
      'click',
      'close',
      'diff',
      'fill',
      'find',
      'focus',
      'get',
      'is',
      'longpress',
      'logs',
      'network',
      'open',
      'perf',
      'press',
      'record',
      'settings',
      'screenshot',
      'scroll',
      'snapshot',
      'swipe',
      'trigger-app-event',
      'type',
      'wait',
    ],
    [{ device: macOsDevice, expected: true, label: 'on macOS' }],
  );
  assertCommandSupport(
    [
      'app-switcher',
      'boot',
      'home',
      'install',
      'install-from-source',
      'pinch',
      'push',
      'reinstall',
      'rotate',
    ],
    [{ device: macOsDevice, expected: false, label: 'on macOS' }],
  );
});

test('tvOS follows iOS capability matrix by device kind', () => {
  assertCommandSupport(
    [
      'open',
      'close',
      'apps',
      'screenshot',
      'trigger-app-event',
      'logs',
      'reinstall',
      'boot',
      'shutdown',
    ],
    [{ device: tvOsSimulator, expected: true, label: 'on tvOS' }],
  );
  assertCommandSupport(
    [
      'snapshot',
      'wait',
      'press',
      'get',
      'fill',
      'scroll',
      'back',
      'home',
      'app-switcher',
      'record',
    ],
    [{ device: tvOsSimulator, expected: true, label: 'on tvOS' }],
  );
  assertCommandSupport(
    ['push', 'settings', 'alert'],
    [{ device: tvOsSimulator, expected: true, label: 'on tvOS simulator' }],
  );
  assert.equal(
    isCommandSupportedOnDevice('pinch', tvOsSimulator),
    false,
    'pinch on tvOS simulator',
  );
  assert.equal(
    isCommandSupportedOnDevice('keyboard', tvOsSimulator),
    false,
    'keyboard on tvOS simulator',
  );
  assert.equal(
    isCommandSupportedOnDevice('rotate', tvOsSimulator),
    false,
    'rotate on tvOS simulator',
  );
});

test('Linux supports desktop interaction commands and blocks mobile/unsupported ones', () => {
  assertCommandSupport(
    [
      'back',
      'click',
      'clipboard',
      'close',
      'diff',
      'fill',
      'find',
      'focus',
      'get',
      'home',
      'is',
      'longpress',
      'open',
      'press',
      'screenshot',
      'scroll',
      'snapshot',
      'swipe',
      'type',
      'wait',
    ],
    [{ device: linuxDevice, expected: true, label: 'on Linux' }],
  );
  assertCommandSupport(
    [
      'alert',
      'app-switcher',
      'apps',
      'boot',
      'install',
      'install-from-source',
      'keyboard',
      'logs',
      'network',
      'perf',
      'pinch',
      'push',
      'record',
      'reinstall',
      'rotate',
      'settings',
      'shutdown',
      'trigger-app-event',
    ],
    [{ device: linuxDevice, expected: false, label: 'on Linux' }],
  );
});

test('web supports only the initial browser interaction slice', () => {
  assertCommandSupport(
    [
      'click',
      'close',
      'fill',
      'focus',
      'find',
      'get',
      'is',
      'open',
      'press',
      'screenshot',
      'scroll',
      'snapshot',
      'type',
      'wait',
    ],
    [{ device: webDevice, expected: true, label: 'on web' }],
  );
  assertCommandSupport(
    [
      'alert',
      'app-switcher',
      'apps',
      'back',
      'boot',
      'clipboard',
      'diff',
      'fling',
      'home',
      'install',
      'install-from-source',
      'keyboard',
      'logs',
      'longpress',
      'network',
      'pan',
      'perf',
      'pinch',
      'push',
      'record',
      'reinstall',
      'rotate',
      'settings',
      'shutdown',
      'swipe',
      'trigger-app-event',
    ],
    [{ device: webDevice, expected: false, label: 'on web' }],
  );
});

test('apple selector does not match web platform', () => {
  assert.equal(matchesPlatformSelector(webDevice.platform, 'apple'), false);
  assert.equal(matchesPlatformSelector(webDevice.platform, 'web'), true);
});

test('unknown commands default to supported', () => {
  assert.equal(isCommandSupportedOnDevice('some-future-cmd', iosSimulator), true);
  assert.equal(isCommandSupportedOnDevice('some-future-cmd', androidDevice), true);
  assert.equal(isCommandSupportedOnDevice('some-future-cmd', linuxDevice), true);
});

test('synthesis gestures carry an actionable unsupported hint at admission', () => {
  // macOS / tvOS / physical iOS are rejected at admission; the hint redirects to where the
  // two-finger synthesis path actually works, so callers do not just see a bare "not supported".
  for (const command of ['pinch', 'rotate-gesture', 'transform-gesture']) {
    assert.match(
      unsupportedHintForDevice(command, macOsDevice) ?? '',
      /multi-touch/i,
      `${command} macOS hint`,
    );
    assert.match(
      unsupportedHintForDevice(command, tvOsSimulator) ?? '',
      /touch/i,
      `${command} tvOS hint`,
    );
    assert.match(
      unsupportedHintForDevice(command, iosDevice) ?? '',
      /simulator/i,
      `${command} iOS device hint`,
    );
    // Where the gesture IS supported there is nothing to hint.
    assert.equal(
      unsupportedHintForDevice(command, iosSimulator),
      undefined,
      `${command} iOS sim (supported) hint`,
    );
  }
  // Commands without a hint hook return undefined (admission keeps its generic message).
  assert.equal(unsupportedHintForDevice('tap', macOsDevice), undefined);
});
