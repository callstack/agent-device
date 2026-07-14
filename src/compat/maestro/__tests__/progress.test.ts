import { expect, test } from 'vitest';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { formatMaestroCommandProgress } from '../progress.ts';

test('formats progress directly from typed Maestro commands', () => {
  const program = parseMaestroProgram(
    [
      '---',
      '- tapOn:',
      '    id: next-page',
      '- swipe:',
      '    start: 90%, 50%',
      '    end: 10%, 50%',
      '- assertVisible: Page 2',
    ].join('\n'),
  );

  expect(program.commands.map(formatMaestroCommandProgress)).toEqual([
    { command: 'tapOn', value: 'next-page' },
    { command: 'swipe', value: '90,50% to 10,50%' },
    { command: 'assertVisible', value: 'Page 2' },
  ]);
});

test('redacts typed values from progress output', () => {
  const program = parseMaestroProgram('---\n- inputText: highly-sensitive\n');

  expect(program.commands.map(formatMaestroCommandProgress)).toEqual([
    { command: 'inputText', value: '<text>' },
  ]);
});
