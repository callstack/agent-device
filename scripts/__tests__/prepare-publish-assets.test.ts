import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { preparePublishAssets } from '../prepare-publish-assets.mjs';

test('prepares both Android runtime helpers through the shared publish owner', () => {
  const root = mkdtempForTestSync('agent-device-publish-assets-');
  const scriptsDirectory = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDirectory, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(scriptsDirectory, 'package-apple-runner-source.mjs'), '');
  fs.writeFileSync(
    path.join(scriptsDirectory, 'package-android-helper.sh'),
    `#!/bin/sh
set -eu
if [ "$AGENT_DEVICE_ANDROID_HELPER" = "snapshot" ]; then
  output="$3"
else
  output="$2"
fi
mkdir -p "$output"
prefix="agent-device-android-$AGENT_DEVICE_ANDROID_HELPER-helper-$1"
printf apk > "$output/$prefix.apk"
printf manifest > "$output/$prefix.manifest.json"
printf checksum > "$output/$prefix.apk.sha256"
`,
  );

  const stalePath = path.join(root, 'android', 'ime-helper', 'dist', 'stale.apk');
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.writeFileSync(stalePath, 'stale');

  preparePublishAssets({ root });

  assert.equal(fs.existsSync(stalePath), false);
  for (const helper of ['snapshot', 'ime']) {
    const prefix = `agent-device-android-${helper}-helper-1.2.3`;
    const directory = path.join(root, 'android', `${helper}-helper`, 'dist');
    assert.deepEqual(fs.readdirSync(directory).sort(), [
      `${prefix}.apk`,
      `${prefix}.apk.sha256`,
      `${prefix}.manifest.json`,
    ]);
  }
});
