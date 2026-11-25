import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isMetroStatusBody,
  parseAppReportedServerUrl,
  parseLsofListeningSockets,
  parseMetroProjectRootHeader,
  parseNetstatListeningSockets,
  projectRootsOverlap,
  socketUrl,
} from './metro-dev-server-parsing.ts';

test('a /status body counts as a running dev server only when it names the packager', () => {
  assert.equal(isMetroStatusBody('packager-status:running'), true);
  assert.equal(isMetroStatusBody('<html>packager-status:running</html>'), true);
  assert.equal(isMetroStatusBody('packager-status:not-running'), false);
  assert.equal(isMetroStatusBody('<h1>Not Found</h1>'), false);
});

test('the project-root header is kept plain, percent-decoded, or dropped when empty', () => {
  assert.equal(parseMetroProjectRootHeader('/home/dev/app'), '/home/dev/app');
  assert.equal(parseMetroProjectRootHeader('  /home/dev/app  '), '/home/dev/app');
  assert.equal(
    parseMetroProjectRootHeader('C%3A%5CUsers%5Cdev%5Cproyecto%20n%E2%80%99%C3%AD'),
    String.raw`C:\Users\dev\proyecto n’í`,
  );
  assert.equal(parseMetroProjectRootHeader('/app/%E2%80%'), '/app/%E2%80%');
  assert.equal(parseMetroProjectRootHeader(''), undefined);
  assert.equal(parseMetroProjectRootHeader('   '), undefined);
  assert.equal(parseMetroProjectRootHeader(null), undefined);
});

test('lsof field output yields each listening socket once, ordered by port', () => {
  assert.deepEqual(
    parseLsofListeningSockets('p956\nf9\nn*:7000\nn127.0.0.1:8081\np12\nn[::1]:8081\n'),
    [
      { host: '127.0.0.1', port: 7000 },
      { host: '127.0.0.1', port: 8081 },
      { host: '::1', port: 8081 },
    ],
  );
});

test('lsof keeps the address family it reports, brackets and all', () => {
  // Metro bound to IPv6 loopback only is unreachable on 127.0.0.1, so this is the address it must be
  // dialled at; a wildcard listener is kept as loopback, which reaches every address of this host.
  const sockets = parseLsofListeningSockets(
    'n[::1]:8096\nn127.0.0.1:8096\nn*:8097\nn[2001:db8::1]:8098\n',
  );
  assert.deepEqual(sockets, [
    { host: '127.0.0.1', port: 8096 },
    { host: '::1', port: 8096 },
    { host: '127.0.0.1', port: 8097 },
    { host: '2001:db8::1', port: 8098 },
  ]);
  assert.deepEqual(
    sockets.map((socket) => socketUrl(socket).toString()),
    [
      'http://127.0.0.1:8096/',
      'http://[::1]:8096/',
      'http://127.0.0.1:8097/',
      'http://[2001:db8::1]:8098/',
    ],
  );
});

test('lsof lines that name no socket or no numeric port are skipped', () => {
  assert.deepEqual(parseLsofListeningSockets('p956\nf9\ncTCP\n'), []);
  assert.deepEqual(parseLsofListeningSockets('nlocalhost:http-alt\nn:8081\nn127.0.0.1:0\n'), []);
  assert.deepEqual(parseLsofListeningSockets('n127.0.0.1:8081junk\nn]:8081\n'), []);
});

test('netstat output yields only tcp rows in LISTEN state, deduplicated and ordered', () => {
  assert.deepEqual(
    parseNetstatListeningSockets(
      [
        'tcp4 0 0 127.0.0.1.8081 *.* LISTEN',
        'tcp4 0 0 127.0.0.1.8081 127.0.0.1.55121 ESTABLISHED',
        'tcp6 0 0 ::1.8096 *.* LISTEN',
        'tcp4 0 0 127.0.0.1.8081 *.* LISTEN',
        'udp4 0 0 127.0.0.1.5353 *.*',
      ].join('\n'),
    ),
    [
      { host: '127.0.0.1', port: 8081 },
      { host: '::1', port: 8096 },
    ],
  );
});

test('both netstat address spellings name their host and port, and a wildcard names loopback', () => {
  // Linux prints `127.0.0.1:8081` and `[::1]:8096`; macOS prints `127.0.0.1.8081` and `::1.8096`.
  assert.deepEqual(parseNetstatListeningSockets('tcp4 0 0 127.0.0.1:8081 0.0.0.0:* LISTEN'), [
    { host: '127.0.0.1', port: 8081 },
  ]);
  assert.deepEqual(parseNetstatListeningSockets('tcp4 0 0 *.8081 *.* LISTEN'), [
    { host: '127.0.0.1', port: 8081 },
  ]);
  assert.deepEqual(parseNetstatListeningSockets('tcp6 0 0 [::1]:8096 0.0.0.0:* LISTEN'), [
    { host: '::1', port: 8096 },
  ]);
  assert.deepEqual(parseNetstatListeningSockets('tcp6 0 0 *.8096 *.* LISTEN'), [
    { host: '127.0.0.1', port: 8096 },
  ]);
  // No host before the separator is no address to dial.
  assert.deepEqual(parseNetstatListeningSockets('tcp4 0 0 *.*.* LISTEN'), []);
  assert.deepEqual(parseNetstatListeningSockets('tcp4 0 0 127.0.0.1.8081 *.* TIME_WAIT'), []);
});

test('the app-reported server URL is what RCT_jsLocation names, with the stored scheme', () => {
  assert.equal(
    parseAppReportedServerUrl('{"RCT_jsLocation":"127.0.0.1:8096"}')?.toString(),
    'http://127.0.0.1:8096/',
  );
  assert.equal(
    parseAppReportedServerUrl(
      '{"RCT_jsLocation":"10.0.0.5:19000","RCT_packager_scheme":"https"}',
    )?.toString(),
    'https://10.0.0.5:19000/',
  );
});

test('the app-reported server URL is refused for unusable settings', () => {
  for (const json of [
    'not json',
    '[]',
    '"a string"',
    '{}',
    '{"RCT_jsLocation":""}',
    '{"RCT_jsLocation":"   "}',
    '{"RCT_jsLocation":8096}',
    '{"RCT_jsLocation":"127.0.0.1"}',
    '{"RCT_jsLocation":"127.0.0.1:8081junk"}',
    '{"RCT_jsLocation":":8081"}',
    '{"RCT_jsLocation":"127.0.0.1:70000"}',
  ]) {
    assert.equal(parseAppReportedServerUrl(json), undefined, json);
  }
});

test('a stored https scheme that is not exactly "https" still reads as http', () => {
  assert.equal(
    parseAppReportedServerUrl('{"RCT_jsLocation":"127.0.0.1:8081","RCT_packager_scheme":"HTTPS"}')
      ?.protocol,
    'http:',
  );
});

test('project roots overlap when one is the other, a parent, or a child', () => {
  assert.equal(projectRootsOverlap('/app/project', '/app/project'), true);
  assert.equal(projectRootsOverlap('/app/project', '/app/project/packages/mobile'), true);
  assert.equal(projectRootsOverlap('/app/project/packages/mobile', '/app/project'), true);
});

test('a shared path prefix is not a shared project root', () => {
  assert.equal(projectRootsOverlap('/app/project', '/app/project-two'), false);
  assert.equal(projectRootsOverlap('/app/project', '/other/project'), false);
  assert.equal(projectRootsOverlap('/app', '/opt/app'), false);
});

test('project-root overlap compares path segments, not characters', () => {
  // The check is expressed with path.relative, so it follows the platform's own separator.
  const root = path.join('a', 'b');
  const sibling = path.join('a', 'bc');
  assert.equal(projectRootsOverlap(root, sibling), false);
  assert.equal(projectRootsOverlap(root, path.join(root, 'c')), true);
});
