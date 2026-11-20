import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test } from 'vitest';
import { createPlatformPluginHost } from './plugin-host.ts';
import fs from 'node:fs';
import path from 'node:path';

// The managed HarmonyOS plugin resolves HDC from the toolchain roots its host names, and it asks
// this host whether a candidate is executable rather than reading the filesystem itself (R13). A
// host that cannot answer makes the family report a missing toolchain, so the port has to work.
test('the platform plugin host answers whether a path is an executable file', () => {
  const root = mkdtempForTestSync('plugin-host-executable-');
  const script = path.join(root, 'hdc');
  fs.writeFileSync(script, '#!/bin/sh\necho stub\n', { mode: 0o755 });
  const notAFile = path.join(root, 'missing');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'text\n');
  const host = createPlatformPluginHost(createLiveTestHostEnvironment(), root);

  return Promise.all([
    expect(host.isFileExecutable(script)).resolves.toBe(true),
    expect(host.isFileExecutable(path.join(root, 'notes.txt'))).resolves.toBe(false),
    expect(host.isFileExecutable(notAFile)).resolves.toBe(false),
  ]);
});
