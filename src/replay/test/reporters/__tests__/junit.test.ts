import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';
import { createJunitReplayTestReporter } from '../junit.ts';
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
