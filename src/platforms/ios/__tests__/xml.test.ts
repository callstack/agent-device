import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseXmlDocumentSync } from '../../apple/core/xml.ts';

test('parseXmlDocumentSync preserves ordered nodes with attributes and decoded text', () => {
  const nodes = parseXmlDocumentSync(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '<key>CFBundleDisplayName</key>',
      '<string escaped="&quot;yes&quot;">Example &amp; App</string>',
      '<empty enabled="true"/>',
      '</dict>',
      '</plist>',
    ].join(''),
  );

  assert.deepEqual(nodes, [
    {
      name: 'plist',
      attributes: { version: '1.0' },
      text: null,
      children: [
        {
          name: 'dict',
          attributes: {},
          text: null,
          children: [
            { name: 'key', attributes: {}, text: 'CFBundleDisplayName', children: [] },
            {
              name: 'string',
              attributes: { escaped: '"yes"' },
              text: 'Example & App',
              children: [],
            },
            { name: 'empty', attributes: { enabled: 'true' }, text: null, children: [] },
          ],
        },
      ],
    },
  ]);
});

test('parseXmlDocumentSync reads cdata text and skips declarations', () => {
  const nodes = parseXmlDocumentSync(
    [
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<root>',
      '<!-- ignored -->',
      '<value><![CDATA[  <raw>&text</raw>  ]]></value>',
      '</root>',
    ].join(''),
  );

  assert.equal(nodes[0]?.children[0]?.text, '<raw>&text</raw>');
});

test('parseXmlDocumentSync skips UTF-8 byte order marks', () => {
  const nodes = parseXmlDocumentSync('\uFEFF<root/>');

  assert.equal(nodes[0]?.name, 'root');
});

test('parseXmlDocumentSync rejects mismatched closing tags', () => {
  assert.throws(() => parseXmlDocumentSync('<root><child></root>'), /Expected <\/child>/);
});

test('parseXmlDocumentSync does not expand custom doctype entities', () => {
  const nodes = parseXmlDocumentSync(
    '<!DOCTYPE root [<!ENTITY secret "expanded">]><root>&secret;</root>',
  );

  assert.equal(nodes[0]?.text, '&secret;');
});

test('parseXmlDocumentSync rejects unsafe attribute names', () => {
  for (const attributeName of [
    '__defineGetter__',
    '__defineSetter__',
    '__proto__',
    'constructor',
    'prototype',
  ]) {
    assert.throws(
      () => parseXmlDocumentSync(`<root ${attributeName}="polluted"/>`),
      new RegExp(`Unsupported XML attribute name "${attributeName}"`),
    );
  }
});

test('parseXmlDocumentSync rejects excessive nesting depth', () => {
  const xml = `${'<node>'.repeat(257)}${'</node>'.repeat(257)}`;

  assert.throws(() => parseXmlDocumentSync(xml), /Maximum XML nesting depth/);
});

test('parseXmlDocumentSync rejects documents above the configured size limit', () => {
  assert.throws(
    () => parseXmlDocumentSync('<root>oversized</root>', { maxDocumentChars: 10 }),
    /XML document exceeds maximum supported size of 10 characters/,
  );
});
