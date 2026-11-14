import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveMcpConfigDefaults } from '../tool-input-config.ts';

/**
 * Points `~` at an empty directory so a developer's own user config cannot join the resolution,
 * and writes the project config the test asserts against into the isolated cwd.
 */
function projectHostWithConfig(config: Record<string, unknown>): {
  cwd: string;
  host: { env: Record<string, string>; cwd: string };
} {
  const home = mkdtempForTestSync('agent-device-mcp-home-');
  const cwd = mkdtempForTestSync('agent-device-mcp-project-');
  fs.writeFileSync(path.join(cwd, 'agent-device.json'), JSON.stringify(config));
  return {
    cwd,
    host: { env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' }, cwd },
  };
}

test('a project count for press series reaches a press tool call as a default', () => {
  const { host } = projectHostWithConfig({ count: 3 });

  const { input } = resolveMcpConfigDefaults('press', {}, { count: { type: 'integer' } }, host);

  assert.equal(input.count, 3);
});

// The screenshot burst flags are explicit-only (CommandSchema). The tool call is the typed
// invocation, so a repository `count` tuned for press and swipe series must not arm a burst.
test('a project count never reaches a screenshot tool call', () => {
  const { host } = projectHostWithConfig({ count: 3 });

  const { input } = resolveMcpConfigDefaults(
    'screenshot',
    {},
    { count: { type: 'integer' } },
    host,
  );

  assert.equal(input.count, undefined);
});

test('a count the tool call typed reaches a screenshot, and wins over any default', () => {
  const { host } = projectHostWithConfig({ count: 3 });

  const { input } = resolveMcpConfigDefaults(
    'screenshot',
    { count: 5 },
    { count: { type: 'integer' } },
    host,
  );

  assert.equal(input.count, 5);
});
