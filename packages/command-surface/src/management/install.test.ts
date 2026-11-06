import assert from 'node:assert/strict';
import { test } from 'vitest';
import { helpBody } from '@agent-device/command-registry/command-text';
import { listCommandFamilyCliSchemas } from '../family/registry.ts';

// The install synopsis names only generic paths, so the help body is the one
// surface that tells an agent which binary formats install accepts and shows
// the path-only HarmonyOS .hap shape. Losing the cliDetail drops that example
// without breaking any structural invariant.
test('install help body names the app formats and the HarmonyOS .hap shape', () => {
  const body = helpBody(listCommandFamilyCliSchemas().install!.text);
  assert.match(body, /Formats: Android \.apk and \.aab, iOS \.app and \.ipa, HarmonyOS \.hap\./);
  assert.match(
    body,
    /agent-device install \.\/build\/entry-default-signed\.hap --platform harmonyos/,
  );
  assert.match(body, /the bundle name is read from the archive when the app identifier is absent/);
});
