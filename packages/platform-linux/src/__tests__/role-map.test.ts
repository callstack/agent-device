import { test } from 'vitest';
import assert from 'node:assert/strict';
import { normalizeAtspiRole } from '../role-map.ts';

test('maps common AT-SPI2 roles to normalized types', () => {
  assert.equal(normalizeAtspiRole('push button'), 'Button');
  assert.equal(normalizeAtspiRole('toggle button'), 'Button');
  assert.equal(normalizeAtspiRole('label'), 'StaticText');
  assert.equal(normalizeAtspiRole('text'), 'TextField');
  assert.equal(normalizeAtspiRole('entry'), 'TextField');
  assert.equal(normalizeAtspiRole('check box'), 'CheckBox');
  assert.equal(normalizeAtspiRole('radio button'), 'RadioButton');
  assert.equal(normalizeAtspiRole('menu item'), 'MenuItem');
  assert.equal(normalizeAtspiRole('frame'), 'Window');
  assert.equal(normalizeAtspiRole('dialog'), 'Dialog');
  assert.equal(normalizeAtspiRole('panel'), 'Group');
  assert.equal(normalizeAtspiRole('list'), 'List');
  assert.equal(normalizeAtspiRole('list item'), 'ListItem');
  assert.equal(normalizeAtspiRole('slider'), 'Slider');
  assert.equal(normalizeAtspiRole('image'), 'Image');
  assert.equal(normalizeAtspiRole('link'), 'Link');
  assert.equal(normalizeAtspiRole('application'), 'Application');
  assert.equal(normalizeAtspiRole('combo box'), 'ComboBox');
  assert.equal(normalizeAtspiRole('page tab'), 'Tab');
  assert.equal(normalizeAtspiRole('scroll bar'), 'ScrollBar');
  assert.equal(normalizeAtspiRole('separator'), 'Separator');
  assert.equal(normalizeAtspiRole('tool tip'), 'Tooltip');
});

test('normalizes role name case and whitespace', () => {
  assert.equal(normalizeAtspiRole('Push Button'), 'Button');
  assert.equal(normalizeAtspiRole('LABEL'), 'StaticText');
  assert.equal(normalizeAtspiRole('  menu item  '), 'MenuItem');
});

test('falls back to PascalCase for unmapped roles', () => {
  assert.equal(normalizeAtspiRole('custom widget'), 'CustomWidget');
  assert.equal(normalizeAtspiRole('some-fancy_role'), 'SomeFancyRole');
  assert.equal(normalizeAtspiRole('unknown'), 'Unknown');
});
