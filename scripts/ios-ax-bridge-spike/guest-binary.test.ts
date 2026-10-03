import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  EXPECTED_GUEST_BINARY_SHA256,
  readVerifiedGuestMechanism,
  sha256File,
} from './guest-binary.ts';

describe('guest binary provenance', () => {
  test('hashes the supplied file bytes', () => {
    const file = temporaryFile('verified bytes');
    expect(sha256File(file)).toBe(
      '186287b2d987891f027b4bc8baaf621a3e5a4a73ec78e04b0f65dc309b1ccc03',
    );
  });

  test('rejects a supplied binary that is not the pinned idb guest', () => {
    const file = temporaryFile('arbitrary bridge');
    expect(() => readVerifiedGuestMechanism(file)).toThrow(
      `expected ${EXPECTED_GUEST_BINARY_SHA256}`,
    );
  });
});

function temporaryFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-binary-test-'));
  const file = path.join(directory, 'SimulatorFrameworkBridge');
  fs.writeFileSync(file, contents);
  return file;
}
