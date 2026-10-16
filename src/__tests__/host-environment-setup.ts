import { aroundEach } from 'vitest';

// Code that has no host of its own reads the enclosing command host, and production roots open
// one. A unit test is its own root, and many assign `process.env` directly, so each test runs as
// a host whose environment is the live process environment. The module loads inside the hook, so
// it is the instance the test's own imports see, and a suite that mocks `node:child_process` or
// replaces the module wholesale still gets its mock.
aroundEach(async (runTest) => {
  let withCommandHost: typeof import('@agent-device/host-kit/command').withCommandHost | undefined;
  try {
    ({ withCommandHost } = await import('@agent-device/host-kit/command'));
  } catch {
    // A suite that replaces the module wholesale has no scope to bind.
  }
  if (!withCommandHost) {
    await runTest();
    return;
  }
  await withCommandHost(
    { host: { env: process.env, cwd: process.cwd() }, requestEnv: undefined },
    async () => await runTest(),
  );
});
