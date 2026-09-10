import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  IOS_SYSTEM_SURFACE_DISCLOSURE,
  IOS_SYSTEM_SURFACE_HOSTS,
  iosSystemSurfaceDisclosure,
  iosSystemSurfaceOpenRefusal,
  isIosSystemSurfaceHost,
} from './ios-system-surface.ts';

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

test('isIosSystemSurfaceHost recognizes registered hosts and rejects others', () => {
  expect(isIosSystemSurfaceHost('com.apple.SafariViewService')).toBe(true);
  expect(isIosSystemSurfaceHost('com.example.app')).toBe(false);
  expect(isIosSystemSurfaceHost(undefined)).toBe(false);
});

test('the open refusal names the bundle and does not claim to open it', () => {
  const refusal = iosSystemSurfaceOpenRefusal('com.apple.SafariViewService');
  expect(refusal).toContain('com.apple.SafariViewService');
  expect(refusal.toLowerCase()).not.toContain('opened it');
});

test('the disclosure is present only when provenance is present', () => {
  expect(iosSystemSurfaceDisclosure(undefined)).toBeUndefined();
  expect(
    iosSystemSurfaceDisclosure({ bundleId: 'com.apple.SafariViewService', kind: 'web-auth' }),
  ).toBe(IOS_SYSTEM_SURFACE_DISCLOSURE);
});
