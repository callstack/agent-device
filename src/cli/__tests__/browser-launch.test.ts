import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isSafeBrowserUrl, openUrlInBrowser } from '../browser-launch.ts';
import {
  recordCommandSpawns,
  withMockedPlatform,
} from '../../__tests__/test-utils/host-execution.ts';

// A verification URI may carry `&`, `^`, and `%` verbatim, which a shell would re-tokenize.
const METACHARACTER_URL = 'https://cloud.example/device?user_code=ABCD-EFGH&calc&next=%2Fstart';

async function launchOn(platform: NodeJS.Platform, url = METACHARACTER_URL) {
  const launches = recordCommandSpawns();
  const opened = await withMockedPlatform(
    platform,
    async () => await launches.run(async () => await openUrlInBrowser(url)),
  );
  return { opened, spawns: launches.spawns };
}

test('windows browser launch hands the verification URL to rundll32 argv, never to cmd', async () => {
  const { opened, spawns } = await launchOn('win32');

  assert.equal(opened, true);
  assert.deepEqual(spawns, [
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', METACHARACTER_URL] },
  ]);
});

test('macOS and Linux browser launch pass the verification URL as one argv entry', async () => {
  const darwin = await launchOn('darwin');
  const linux = await launchOn('linux');

  assert.deepEqual(darwin.spawns, [{ command: 'open', args: [METACHARACTER_URL] }]);
  assert.deepEqual(linux.spawns, [{ command: 'xdg-open', args: [METACHARACTER_URL] }]);
});

test('browser launch reports failure when the launcher refuses the URL', async () => {
  const launches = recordCommandSpawns({ exitCode: 3 });

  const opened = await withMockedPlatform(
    'linux',
    async () => await launches.run(async () => await openUrlInBrowser(METACHARACTER_URL)),
  );

  assert.equal(opened, false);
  assert.equal(launches.spawns.length, 1);
});

test('browser launch keeps a Windows handoff that reports a non-zero status', async () => {
  const launches = recordCommandSpawns({ exitCode: 3 });

  const opened = await withMockedPlatform(
    'win32',
    async () => await launches.run(async () => await openUrlInBrowser(METACHARACTER_URL)),
  );

  assert.equal(opened, true);
  assert.deepEqual(launches.spawns, [
    { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', METACHARACTER_URL] },
  ]);
});

test('browser launch refuses a URL that is not an http(s) URL without spawning', async () => {
  for (const url of [
    'javascript:alert(document.cookie)',
    'file:///etc/passwd',
    'https://cloud.example\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007',
    'not a url',
    '',
  ]) {
    const launches = recordCommandSpawns();
    const opened = await launches.run(async () => await openUrlInBrowser(url));

    assert.equal(opened, false, url);
    assert.deepEqual(launches.spawns, [], url);
  }
});

test('browser URL guard accepts http(s) URLs and rejects every other scheme', () => {
  assert.equal(isSafeBrowserUrl('http://cloud.example/authorize'), true);
  assert.equal(isSafeBrowserUrl(METACHARACTER_URL), true);
  assert.equal(isSafeBrowserUrl('javascript:alert(document.cookie)'), false);
  assert.equal(isSafeBrowserUrl('file:///etc/passwd'), false);
  assert.equal(isSafeBrowserUrl('mailto:someone@example.com'), false);
  assert.equal(isSafeBrowserUrl('cloud.example/authorize'), false);
  assert.equal(isSafeBrowserUrl(''), false);
});

test('browser URL guard rejects characters a terminal would act on or that spoof a URL', () => {
  assert.equal(isSafeBrowserUrl('https://cloud.example/authorize\u0000#fragment'), false);
  assert.equal(
    isSafeBrowserUrl(
      'https://cloud.example/\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007',
    ),
    false,
  );
  assert.equal(isSafeBrowserUrl('https://cloud.example/\u009b31mred'), false);
  assert.equal(isSafeBrowserUrl('https://cloud.example/apj.exe\u202Egpj.exe'), false);
  assert.equal(isSafeBrowserUrl('https://cloud.example/a\u200bb'), false);
});
