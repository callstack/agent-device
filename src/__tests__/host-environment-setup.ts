import { beforeAll, beforeEach } from 'vitest';

// Code that has no host of its own reads the enclosing command host, and production roots open
// one. A unit test is its own root, and many assign `process.env` directly, so each test gets the
// live process environment as its host. The module loads after the test file's own imports, so
// a suite that mocks `node:child_process` still sees its mock.
let enterCommandHost: typeof import('@agent-device/host-kit/command').enterCommandHost | undefined;

beforeAll(async () => {
  const command = await import('@agent-device/host-kit/command');
  try {
    enterCommandHost = command.enterCommandHost;
  } catch {
    // A suite that replaces the module wholesale has no scope to enter.
  }
});

beforeEach(() => {
  enterCommandHost?.({ host: { env: process.env, cwd: process.cwd() }, requestEnv: undefined });
});
