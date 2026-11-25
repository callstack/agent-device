import { test } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isMetroStatusBody,
  parseAppReportedServerUrl,
  parseLsofListeningPorts,
  parseMetroProjectRootHeader,
  parseNetstatListeningPorts,
  parsePortFromSocketName,
  projectRootsOverlap,
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
    'C:\\Users\\dev\\proyecto n’í',
  );
  assert.equal(parseMetroProjectRootHeader('/app/%E2%80%'), '/app/%E2%80%');
  assert.equal(parseMetroProjectRootHeader(''), undefined);
  assert.equal(parseMetroProjectRootHeader('   '), undefined);
  assert.equal(parseMetroProjectRootHeader(null), undefined);
});

test('lsof field output yields each listening port once, ascending', () => {
  assert.deepEqual(
    parseLsofListeningPorts('p956\nf9\nn*:7000\nn127.0.0.1:8081\np12\nn[::1]:8081\n'),
    [7000, 8081],
  );
});

test('lsof lines that name no socket or no numeric port are skipped', () => {
  assert.deepEqual(parseLsofListeningPorts('p956\nf9\ncTCP\n'), []);
  assert.deepEqual(parseLsofListeningPorts('nlocalhost:http-alt\nn:8081\nn127.0.0.1:0\n'), []);
});

test('netstat output yields only tcp rows in LISTEN state, deduplicated and ascending', () => {
  assert.deepEqual(
    parseNetstatListeningPorts(
      [
        'tcp4 0 0 127.0.0.1.8081 *.* LISTEN',
        'tcp4 0 0 127.0.0.1.8081 127.0.0.1.55121 ESTABLISHED',
        'tcp6 0 0 ::1.8096 *.* LISTEN',
        'tcp4 0 0 127.0.0.1.8081 *.* LISTEN',
        'udp4 0 0 127.0.0.1.5353 *.*',
      ].join('\n'),
    ),
    [8081, 8096],
  );
});

test('both netstat address spellings name their port, and a wildcard still names none', () => {
  // Linux prints `127.0.0.1:8081`; macOS prints `127.0.0.1.8081`.
  assert.deepEqual(parseNetstatListeningPorts('tcp4 0 0 127.0.0.1:8081 0.0.0.0:* LISTEN'), [8081]);
  assert.deepEqual(parseNetstatListeningPorts('tcp4 0 0 *.8081 *.* LISTEN'), [8081]);
  assert.deepEqual(parseNetstatListeningPorts('tcp4 0 0 *.*.* LISTEN'), []);
});

test('the port a socket name ends with is read only when it is a real port', () => {
  assert.equal(parsePortFromSocketName('127.0.0.1:8081'), 8081);
  assert.equal(parsePortFromSocketName('[::1]:8096'), 8096);
  assert.equal(parsePortFromSocketName('127.0.0.1:8081junk'), undefined);
  assert.equal(parsePortFromSocketName('127.0.0.1:70000'), undefined);
  assert.equal(parsePortFromSocketName('127.0.0.1:0'), undefined);
  assert.equal(parsePortFromSocketName('8081'), undefined);
  assert.equal(parsePortFromSocketName(':8081'), undefined);
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
