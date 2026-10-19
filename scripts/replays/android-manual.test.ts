import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { expect, test } from 'vitest';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '@agent-device/test-kit';

const pipeline = (serial: string) => [
  'pnpm|gate build',
  'pnpm|clean:daemon',
  `adb|-s ${serial} install -r fixture.apk`,
  `node|--experimental-strip-types src/bin.ts replay examples/test-app/replays/drag-android.ad --platform android --serial ${serial} --session nightly-android-target-drag --json`,
  'pnpm|clean:daemon',
  'node|--experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-android-emulator.test.ts',
  `env|1|full|${serial}|fixture.apk|com.fixture`,
  'pnpm|gate replay-android --retries 2 --artifacts-dir test/artifacts/replays-android --report-junit test/artifacts/replays-android.junit.xml',
];

test.each([
  { serial: 'emulator-7000', fullExit: 0 },
  { serial: 'emulator-8100', fullExit: 0 },
  { serial: 'emulator-8100', fullExit: 13 },
])(
  'manual action preserves serial $serial and full-suite status $fullExit with timing',
  async ({ serial, fullExit }) => {
    const cwd = await mkdtempForTest('android-manual-shell-');
    const bin = path.join(cwd, 'bin');
    fs.mkdirSync(bin);
    const tool = (name: string, body: string) =>
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    tool(
      'pnpm',
      String.raw`printf 'pnpm|%s\n' "$*" >> calls.log
case "$1 $2" in
 'gate build') exit "$BUILD_EXIT";;
 'gate replay-android') exit "$REPLAY_EXIT";;
esac`,
    );
    tool(
      'adb',
      String.raw`if [ "$1" = devices ]; then
 printf 'List of devices attached\n%s\tdevice\n' "$EXPECTED_SERIAL"
 exit 0
fi
printf 'adb|%s\n' "$*" >> calls.log
test "$1" = -s && test "$2" = "$EXPECTED_SERIAL" || exit 42
exit "$INSTALL_EXIT"`,
    );
    tool(
      'node',
      String.raw`printf 'node|%s\n' "$*" >> calls.log
if [ "$3" = replay ]; then exit "$DRAG_EXIT"; fi
printf 'env|%s|%s|%s|%s|%s\n' "$AGENT_DEVICE_ANDROID_E2E" "$AGENT_DEVICE_ANDROID_E2E_TIER" "$AGENT_DEVICE_ANDROID_SERIAL" "$AGENT_DEVICE_FIXTURE_APP_PATH" "$AGENT_DEVICE_FIXTURE_APP_ID" >> calls.log
exit "$FULL_EXIT"`,
    );
    tool(
      'date',
      String.raw`case "$(cat clock-index 2>/dev/null || echo 0)" in
 0) echo 100; echo 1 > clock-index;;
 1) echo 120; echo 2 > clock-index;;
 *) echo 145;;
esac`,
    );
    fs.mkdirSync(path.join(cwd, 'scripts/replays'), { recursive: true });
    fs.symlinkSync(
      path.resolve('scripts/replays/android-manual.sh'),
      path.join(cwd, 'scripts/replays/android-manual.sh'),
    );
    const workflow = parse(fs.readFileSync('.github/workflows/replays-manual.yml', 'utf8'));
    const runner = workflow.jobs['manual-android'].steps.find((step: { uses?: string }) =>
      step.uses?.startsWith('reactivecircus/android-emulator-runner@'),
    );
    const script: string = runner.with.script
      .replaceAll('${{ steps.fixture-app.outputs.apk-path }}', 'fixture.apk')
      .replaceAll('${{ steps.fixture-app.outputs.app-id }}', 'com.fixture')
      .replaceAll('${{ steps.android-setup.outputs.seconds }}', '90');
    let result = { exitCode: 0, stderr: '', stdout: '' };
    let stdout = '';

    for (const command of script.split('\n').map((line) => line.trim())) {
      if (!command || command.startsWith('#')) continue;
      result = runCmdSync('sh', ['-c', command], {
        cwd,
        allowFailure: true,
        timeoutMs: 10_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          ANDROID_SERIAL: serial,
          EXPECTED_SERIAL: serial,
          BUILD_EXIT: '0',
          INSTALL_EXIT: '0',
          DRAG_EXIT: '0',
          FULL_EXIT: String(fullExit),
          REPLAY_EXIT: '0',
        },
      });
      stdout += result.stdout;
      if (result.exitCode !== 0) break;
    }
    expect(result.exitCode, result.stderr).toBe(fullExit);
    const expected = pipeline(serial);
    expect(fs.readFileSync(path.join(cwd, 'calls.log'), 'utf8').trim().split('\n')).toEqual(
      fullExit === 0 ? expected : expected.slice(0, -1),
    );
    expect(stdout).toContain('Android setup before emulator: 10s');
    expect(stdout).toContain('Android full scenario wall time: 25s');
  },
);
