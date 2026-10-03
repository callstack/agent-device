import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  APP_SURFACE,
  IOS_SYSTEM_SURFACE_HOSTS,
  iosSystemSurfaceDisclosure,
  iosSystemSurfaceHost,
  iosSystemSurfaceOpenRefusal,
  iosSystemSurfaceTransitionDisclosure,
} from './ios-system-surface.ts';

const WEB_AUTH_HOST = 'com.apple.SafariViewService';
const PAYMENT_HOST = 'com.apple.PassbookUIService';

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-system-surface-hosts.json',
);

type Fixture = {
  hosts: Array<{ bundleId: string; kind: string; processExecutable: string; note: string }>;
};

function readFixture(): Fixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

// Cross-language parity: the TS registry must mirror the canonical fixture that the Swift
// SystemSurfaceHostRegistry also reads. A drift on either side fails here or in the Swift test.
test('the TS registry mirrors the canonical fixture exactly', () => {
  const fixture = readFixture();
  expect(
    IOS_SYSTEM_SURFACE_HOSTS.map((host) => ({
      bundleId: host.bundleId,
      kind: host.kind,
      processExecutable: host.processExecutable,
    })),
  ).toEqual(
    fixture.hosts.map((host) => ({
      bundleId: host.bundleId,
      kind: host.kind,
      processExecutable: host.processExecutable,
    })),
  );
});

test('iosSystemSurfaceHost resolves registered hosts and rejects others', () => {
  expect(iosSystemSurfaceHost(WEB_AUTH_HOST)?.kind).toBe('web-auth');
  expect(iosSystemSurfaceHost(PAYMENT_HOST)?.kind).toBe('payment');
  expect(iosSystemSurfaceHost('com.example.app')).toBeUndefined();
  expect(iosSystemSurfaceHost(undefined)).toBeUndefined();
});

test('the open refusal names the bundle and its sheet and does not claim to open it', () => {
  const refusal = iosSystemSurfaceOpenRefusal(WEB_AUTH_HOST);
  expect(refusal).toContain(WEB_AUTH_HOST);
  expect(refusal).toContain('web sign-in');
  expect(refusal.toLowerCase()).not.toContain('opened it');
  expect(iosSystemSurfaceOpenRefusal(PAYMENT_HOST)).toContain('Apple Pay');
});

test('the standing disclosure names the kind of sheet the host presents', () => {
  expect(iosSystemSurfaceDisclosure(WEB_AUTH_HOST)).toContain('a system web sign-in sheet');
  expect(iosSystemSurfaceDisclosure(PAYMENT_HOST)).toContain('the system Apple Pay sheet');
  expect(iosSystemSurfaceDisclosure(PAYMENT_HOST)).not.toContain('sign-in');
});

// Only registered hosts are ever stamped on a capture, so an unregistered id reaching a sentence
// is a programming error and must not be described as some plausible sheet.
test('an unregistered host cannot be worded', () => {
  expect(() => iosSystemSurfaceDisclosure('com.example.unknown')).toThrow(/not a registered/);
});

test('the transition disclosure says the sheet is gone only when it left', () => {
  expect(iosSystemSurfaceTransitionDisclosure({ from: APP_SURFACE, to: WEB_AUTH_HOST })).toBe(
    iosSystemSurfaceDisclosure(WEB_AUTH_HOST),
  );
  expect(iosSystemSurfaceTransitionDisclosure({ from: APP_SURFACE, to: PAYMENT_HOST })).toBe(
    iosSystemSurfaceDisclosure(PAYMENT_HOST),
  );
  const departed = iosSystemSurfaceTransitionDisclosure({ from: WEB_AUTH_HOST, to: APP_SURFACE });
  expect(departed).not.toBe(iosSystemSurfaceDisclosure(WEB_AUTH_HOST));
  expect(departed).toContain('gone now');
  expect(departed).toContain('web sign-in');
  expect(iosSystemSurfaceTransitionDisclosure({ from: PAYMENT_HOST, to: APP_SURFACE })).toContain(
    'Apple Pay',
  );
});
