import { test } from 'vitest';
import { assertProducedRunnerRequests } from '@agent-device/test-kit';
import type { MacOsRunner, MacOsRunnerCommand } from '@agent-device/contracts/macos-platform-leaf';
import { runMacOsAlternateClick, runMacOsDesktopScroll } from './runner-commands.ts';

// The macOS wire cases of the Apple XCTest runner that this package maps commands to, driven through
// the leaf's own entry points and pinned to contracts/fixtures/runner-requests.json. The Apple owner
// binds the runner to a device and adds the transport's command id; the request here is what the
// leaf hands that capability.

const APP = 'com.example.app';
const context = { appBundleId: APP };

type Drive = (runner: MacOsRunner) => Promise<unknown>;

const SITES: Record<string, Drive> = {
  'macos.desktop-scroll.amount': (runner) =>
    runMacOsDesktopScroll(runner, context, {}, 'down', { amount: 0.5, durationMs: 300 }),
  'macos.desktop-scroll.pixels': (runner) =>
    runMacOsDesktopScroll(runner, context, {}, 'up', { pixels: 200, durationMs: 300 }),
  'macos.interactions-mouse-click.secondary': (runner) =>
    runMacOsAlternateClick(runner, context, {}, { x: 10, y: 20 }, 'secondary'),
  'macos.interactions-mouse-click.middle': (runner) =>
    runMacOsAlternateClick(runner, context, {}, { x: 10, y: 20 }, 'middle'),
};

test('every macOS leaf request site builds exactly its golden runner request', async () => {
  const captured: Array<readonly [string, MacOsRunnerCommand]> = [];
  for (const [name, drive] of Object.entries(SITES)) {
    const sent: MacOsRunnerCommand[] = [];
    await drive({
      run: async (command) => {
        sent.push(command);
        return {};
      },
    });
    if (sent.length !== 1) throw new Error(`${name} must send exactly one runner request`);
    captured.push([name, sent[0]!]);
  }
  assertProducedRunnerRequests(import.meta.filename, captured);
});
