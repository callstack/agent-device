import assert from 'node:assert/strict';
import { test } from 'vitest';
import { usageForCommand } from '../../cli/parser/args.ts';

test('usageForCommand resolves debugging help topic', async () => {
  const help = await usageForCommand('debugging');
  if (help === null) throw new Error('Expected debugging help text');
  assert.match(help, /^agent-device \S+ — debugging/);
  assert.match(help, /Use logs when you need the lead-up timeline/);
  assert.match(help, /relaunches the session app through devicectl process launch --console/);
  assert.match(help, /Use debug symbols when you have crash\.ips\/crash\.log/);
  assert.match(help, /Use Xcode\/LLDB when you need live state/);
  assert.match(help, /debug symbols --artifact crash\.ips --search-path \.\/build/);
  assert.match(help, /Android Java\/R8 mapping\.txt and native ndk-stack\/addr2line/);
  assert.match(help, /network\/audio evidence/);
  assert.match(help, /agent-device alert wait 3000/);
  assert.match(help, /iOS support is runner-derived/);
  assert.match(help, /resolved app executable/);
  assert.match(help, /--launch-console is only for direct iOS simulator app launches/);
  assert.match(help, /runnerLogPath and requestLogPath/);
  assert.match(
    help,
    /AGENT_DEVICE_EXEC_TRACE=1 when you need host-tool spawn timing without full debug streaming/,
  );
  assert.match(help, /open --debug --json/);
  assert.match(help, /open_timing event/);
  assert.match(help, /requests\/<request-id>\.ndjson holds daemon request diagnostics/);
  assert.match(help, /daemon\.log is global daemon lifecycle evidence/);
  assert.match(help, /agent-device perf memory sample --json/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform web/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform macos/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform ios/);
  assert.match(help, /agent-device audio probe start 10 1000 --platform android/);
  assert.match(help, /compact rmsDbfs and peakDbfs arrays/);
  assert.match(help, /requires Screen Recording permission/);
  assert.match(help, /Physical iOS and Android devices are not supported/);
  assert.match(help, /Memory artifact \(android-hprof\): \/tmp\/app\.hprof \(42MB\)/);
  assert.match(help, /Prefer perf memory sample over raw dumpsys\/leaks output/);
  assert.match(help, /Unsupported platforms return artifact\.available=false with reason\/hint/);
  assert.match(help, /Do not use settings permission to answer a dialog already on screen/);
  assert.match(help, /Treat native perf output as the agent evidence/);
  assert.match(help, /sizeBytes=5392410/);
  assert.match(help, /5\.3 MB raw trace stays in the artifact/);
  assert.match(help, /iOS Allow Paste cannot be exercised under XCUITest/);
  assert.match(help, /prefill with clipboard write "some text"/);
  assert.match(help, /Android Gboard handwriting\/stylus UI can capture text/);
  assert.match(help, /targetInput\/actualInput details/);
  assert.match(help, /Do not keep retrying fill\/type against the same field/);
});

test('usageForCommand resolves manual QA help topic', async () => {
  const help = await usageForCommand('manual-qa');
  if (help === null) throw new Error('Expected manual QA help text');
  assert.match(help, /^agent-device \S+ — manual-qa/);
  assert.match(help, /Execute the script/);
  assert.match(help, /Run snapshot -i to get current refs/);
  assert.match(help, /press\/fill\/click\/longpress <ref-or-selector> --settle/);
  assert.match(help, /A bare screenshot\/snapshot is not verification/);
  assert.match(help, /use fill <target> <text> --settle to replace/);
  assert.match(help, /use type only to append to an already-focused field/);
  assert.match(help, /label="Email" editable=true/);
  assert.match(help, /press 'label="Follow"' --settle/);
  assert.match(help, /Do not use placeholders such as @ref/);
  assert.match(help, /wait text\/selector\/absent/);
  assert.match(help, /wait absent 'label="Loading\.\.\."' 3000/);
  assert.match(help, /wait_target_absent: a readable capture ran and found no match/);
  assert.match(help, /wait_target_present: wait absent timed out with matches/);
  assert.match(help, /wait_capture_stalled: no readable capture finished before the deadline/);
});

test('usageForCommand resolves validate help topic', async () => {
  const help = await usageForCommand('validate');
  if (help === null) throw new Error('Expected validate help text');
  assert.match(help, /^agent-device \S+ — validate/);
  assert.match(help, /validating a code change/);
  assert.match(help, /Required freshness gate before device verification/);
  assert.match(help, /For a TypeScript runtime or CLI output change, start with pnpm build/);
  assert.match(help, /For non-Android device verification, run pnpm clean:daemon next/);
  assert.match(help, /run pnpm build:android before pnpm clean:daemon/);
  assert.match(help, /pnpm build:xcuitest/);
  assert.match(help, /Do not build the Apple runner for TypeScript-only changes/);
  assert.match(help, /Use the settled diff as evidence/);
  assert.match(help, /Close sessions and release leases/);
  assert.match(help, /exact key that includes the agent-device package and Xcode version/);
  assert.match(help, /Runner reuse is authorized only by the cache metadata's content manifest/);
});

test('usageForCommand resolves dogfood help topic', async () => {
  const help = await usageForCommand('dogfood');
  if (help === null) throw new Error('Expected dogfood help text');
  assert.match(help, /^agent-device \S+ — dogfood/);
  assert.match(help, /Find user-visible issues from runtime behavior/);
  assert.match(help, /Severity: critical blocks a core flow\/data\/crashes/);
  assert.match(help, /Interactive\/behavioral issues need step screenshots/);
  assert.match(help, /Static\/on-load issues can use one screenshot/);
  assert.match(help, /React Native warning\/error overlays can be real findings/);
  assert.match(help, /Expo Go\/dev-client shells/);
  assert.match(help, /direct Android localhost URL opens with a port auto-configure/);
  assert.match(help, /Keep stateful commands serial within the same session/);
  assert.match(help, /agent-device wait 'role=tab' 10000/);
  assert.match(help, /scroll takes a selector-less direction\+amount form/);
  assert.match(help, /Use --settle to wait for the UI to go quiet/);
  assert.match(help, /prefer agent-device open "Expo Go" <url>/);
  assert.match(help, /dogfood-output\/report\.md/);
  assert.match(help, /ID, severity, category, title, affected flow\/screen/);
  assert.match(help, /Never delete screenshots, videos, traces, or report artifacts/);
  assert.match(help, /screenshot \.\/dogfood-output\/screenshots\/issue-001\.png --overlay-refs/);
});
