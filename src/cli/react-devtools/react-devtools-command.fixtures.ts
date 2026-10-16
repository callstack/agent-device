import type { CliFlags } from '@agent-device/contracts/command';
import { runReactDevtoolsCommand } from '../commands/react-devtools.ts';
import { vi } from 'vitest';
import vm from 'node:vm';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { InspectorSession } from './metro-inspector.ts';
import type { ReactDevtoolsCommandOptions } from './react-devtools-connection.ts';
import { FakeAppRuntime } from './react-devtools-runtime.fixtures.ts';

export const TARGET = {
  id: 'device-1',
  title: 'com.example.app (Pixel)',
  appId: 'com.example.app',
  webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?device=1&page=1',
  reactNative: { logicalDeviceId: 'device' },
};

/**
 * Serves `targets` from `/json/list`, evaluates debugger calls in `app`'s realm, and captures what
 * the CLI prints. Callers restore the stubbed globals and spies after each test.
 */
export function commandHarness(
  prefix: string[] = [],
  app = new FakeAppRuntime(),
  targets: unknown[] = [TARGET],
) {
  const stateDir = mkdtempForTestSync('react-profile-');
  const output: string[] = [];
  const requested: string[] = [];
  const options: ReactDevtoolsCommandOptions & { flags?: Partial<Pick<CliFlags, 'json'>> } = {
    stateDir,
    session: 'qa',
  };
  vi.stubGlobal('fetch', async (url: URL) => {
    requested.push(String(url));
    return new Response(JSON.stringify(targets), { status: 200 });
  });
  vi.spyOn(InspectorSession, 'connect').mockImplementation(
    async () =>
      ({
        evaluate: async (expression: string) => vm.runInContext(expression, app.context),
        close: () => {},
      }) as unknown as InspectorSession,
  );
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  const run = async (...args: string[]) => {
    output.length = 0;
    const code = await runReactDevtoolsCommand([...prefix, ...args], options);
    return { code, text: output.join('') };
  };
  return { app, run, options, stateDir, requested };
}
