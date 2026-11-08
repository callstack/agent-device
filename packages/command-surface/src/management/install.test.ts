import assert from 'node:assert/strict';
import { test } from 'vitest';
import { helpBody } from '@agent-device/command-registry/command-text';
import { listCommandFamilyCliSchemas } from '../family/registry.ts';

// The install synopsis names only generic paths, so the help body is the one
// surface that shows the path-only HarmonyOS .hap shape.
test('install help body shows the path-only HarmonyOS .hap install', () => {
  const body = helpBody(listCommandFamilyCliSchemas().install!.text);
  assert.match(
    body,
    /agent-device install \.\/build\/entry-default-signed\.hap --platform harmonyos/,
  );
});
