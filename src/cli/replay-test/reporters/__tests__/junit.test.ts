import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';
import { createJunitReplayTestReporter } from '../junit.ts';
import { renderReplayTestResponse } from '../../reporting.ts';
import type { ReplayTestReporterContext } from '../types.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

const context: ReplayTestReporterContext = {
  stdout: { isTTY: false, write() {} },
  stderr: { isTTY: false, write() {} },
};

// Characters that are individually significant to an XML parser: `<` opens a tag, `&` starts an
// entity reference, `"` closes an attribute value, and a raw newline inside an attribute must
// survive as a literal character rather than breaking the attribute boundary.
const TRICKY_TITLE = 'Sign in <required> & "quoted"\nsecond line';
const TRICKY_MESSAGE = 'Expected <button id="ok"> & none found\nsecond line';

function writeSuiteAndParse(suite: ReplaySuiteResult): XmlNode[] {
  const dir = mkdtempForTestSync('agent-device-junit-reporter-');
  const reportPath = path.join(dir, 'report.xml');
  const reporter = createJunitReplayTestReporter(reportPath);
  reporter.onSuiteEnd?.(suite, context);
  const xml = fs.readFileSync(reportPath, 'utf8');
  return parseXmlDocumentSync(xml);
}

function findChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

test('buildReplayJunitXml escapes tricky failure title/message and round-trips through the XML parser', () => {
  const suite: ReplaySuiteResult = {
    total: 1,
    executed: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    notRun: 0,
    durationMs: 1500,
    failures: [],
    tests: [
      {
        file: '/tmp/flows/login.ad',
        title: TRICKY_TITLE,
        session: 'default',
        status: 'failed',
        durationMs: 1500,
        attempts: 1,
        error: { code: 'COMMAND_FAILED', message: TRICKY_MESSAGE },
      },
    ],
  };
  suite.failures = suite.tests.filter((result) => result.status === 'failed');

  // Well-formed XML: a broken escape would make this throw instead of returning nodes.
  const nodes = writeSuiteAndParse(suite);

  const testsuites = nodes[0];
  assert.ok(testsuites);
  assert.equal(testsuites.name, 'testsuites');
  const testsuite = findChild(testsuites, 'testsuite');
  assert.ok(testsuite);
  const testcase = findChild(testsuite, 'testcase');
  assert.ok(testcase);

  // Attribute round-trip: the raw title survives escaping into an attribute value and decoding
  // back out, newline included.
  assert.equal(testcase.attributes.name, TRICKY_TITLE);
  assert.equal(testcase.attributes.file, '/tmp/flows/login.ad');

  const failure = findChild(testcase, 'failure');
  assert.ok(failure);
  assert.equal(failure.attributes.message, TRICKY_MESSAGE);
  // The failure body opens with the raw error message (buildFailureDetails' first line).
  assert.ok(failure.text?.startsWith(TRICKY_MESSAGE));
});

test('buildReplayJunitXml escapes tricky skip message', () => {
  const suite: ReplaySuiteResult = {
    total: 1,
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 1,
    notRun: 0,
    durationMs: 0,
    failures: [],
    tests: [
      {
        file: '/tmp/flows/skipped.ad',
        status: 'skipped',
        durationMs: 0,
        reason: 'skipped-by-filter',
        message: TRICKY_TITLE,
      },
    ],
  };

  const nodes = writeSuiteAndParse(suite);
  const testcase = findChild(findChild(nodes[0]!, 'testsuite')!, 'testcase');
  assert.ok(testcase);
  const skipped = findChild(testcase, 'skipped');
  assert.ok(skipped);
  assert.equal(skipped.attributes.message, TRICKY_TITLE);
});

async function renderCharacterSuite(value: string): Promise<XmlNode> {
  const dir = mkdtempForTestSync('agent-device-junit-characters-');
  const reportPath = path.join(dir, 'report.xml');
  const failed = {
    file: `/flows/${value}/failed.ad`,
    title: value,
    session: value,
    artifactsDir: value,
    status: 'failed' as const,
    durationMs: 12,
    attempts: 1,
    error: { code: 'COMMAND_FAILED' as const, message: value, hint: value },
  };
  const suite: ReplaySuiteResult = {
    total: 2,
    executed: 1,
    passed: 0,
    failed: 1,
    skipped: 1,
    notRun: 0,
    durationMs: 12,
    failures: [failed],
    tests: [
      failed,
      {
        file: '/flows/skipped.ad',
        status: 'skipped',
        durationMs: 0,
        reason: 'skipped-by-filter',
        message: value,
      },
    ],
  };
  const original = structuredClone(suite);

  const exitCode = await renderReplayTestResponse({
    suite,
    reporter: [`junit:${reportPath}`],
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(suite, original);
  const xml = fs.readFileSync(reportPath, 'utf8');
  assert.doesNotMatch(xml, /="[^"]*[\t\n\r][^"]*"/u, 'XML normalizes raw attribute whitespace');
  assert.doesNotMatch(xml, /\r/u, 'XML normalizes raw carriage returns in text');
  const nodes = parseXmlDocumentSync(xml);
  const testsuite = findChild(nodes[0]!, 'testsuite');
  assert.ok(testsuite);
  return testsuite;
}

function assertCharacterValues(testsuite: XmlNode, expected: string): void {
  const [failed, skipped] = testsuite.children;
  assert.ok(failed);
  assert.ok(skipped);
  assert.equal(failed.attributes.name, expected);
  assert.equal(failed.attributes.classname, `/flows/${expected}`);
  assert.equal(failed.attributes.file, `/flows/${expected}/failed.ad`);
  const failure = findChild(failed, 'failure');
  assert.equal(failure?.attributes.message, expected);
  assert.ok(failure?.text?.startsWith(expected));
  assert.ok(failure?.text?.includes(`hint: ${expected}`));
  const systemOut = findChild(failed, 'system-out');
  assert.ok(systemOut?.text?.includes(`session: ${expected}`));
  assert.ok(systemOut?.text?.includes(`artifactsDir: ${expected}`));
  assert.equal(findChild(skipped, 'skipped')?.attributes.message, expected);
}

test.each([0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1b, 0x1f, 0xd800, 0xdfff, 0xfffe, 0xffff])(
  'JUnit replaces XML 1.0 forbidden code point %s without changing the suite result',
  async (codePoint) => {
    const suite = await renderCharacterSuite(`before${String.fromCodePoint(codePoint)}after`);
    assertCharacterValues(suite, 'before\uFFFDafter');
  },
);

test('JUnit preserves legal XML whitespace, Unicode boundaries and markup characters', async () => {
  const value =
    'before\t\n\r<&"\'&#0;&#xFFFF;\u0020\u007F\u0085\uD7FF\uE000\uFFFD\u{10000}\u{1FFFE}\u{10FFFF}after';
  const suite = await renderCharacterSuite(value);
  assertCharacterValues(suite, value);
});
