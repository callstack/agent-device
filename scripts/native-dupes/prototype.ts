import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runCmdSync } from '@agent-device/host-kit/command';
import {
  countMotivatingClones,
  namedConstantRange,
  type PrototypeClone,
} from './prototype-report.ts';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'node_modules/jscpd/run-jscpd.js');
const output = path.join(root, '.tmp/native-dupes-prototypes');
const pair = [
  'packages/platform-apple/src/core/__tests__/display-inventory.test.ts',
  'packages/platform-apple/src/__tests__/simctl-facade.test.ts',
];
const duoRange = namedConstantRange(
  fs.readFileSync(path.join(root, pair[1]!), 'utf8'),
  'IPHONE_DUO_CLOSED',
);
const variants = [
  { name: 'mild-50-5', tokens: 50, lines: 5, mode: 'mild', extra: [] },
  { name: 'weak-50-5', tokens: 50, lines: 5, mode: 'weak', extra: [] },
  { name: 'weak-70-5', tokens: 70, lines: 5, mode: 'weak', extra: [] },
  { name: 'weak-100-8', tokens: 100, lines: 8, mode: 'weak', extra: [] },
  { name: 'weak-30-3', tokens: 30, lines: 3, mode: 'weak', extra: [] },
  { name: 'weak-20-3', tokens: 20, lines: 3, mode: 'weak', extra: [] },
  {
    name: 'renamed-50-5',
    tokens: 50,
    lines: 5,
    mode: 'weak',
    extra: ['--ignore-identifiers=consistent'],
  },
  { name: 'gap-30-3', tokens: 30, lines: 3, mode: 'weak', extra: ['--max-gap-lines', '8'] },
];

type Report = {
  statistics: {
    total: { clones: number; duplicatedLines: number; percentage: number; sources: number };
  };
  duplicates: PrototypeClone[];
};

const rows = [];
for (const variant of variants) {
  for (const scope of ['native', 'duo'] as const) {
    const destination = path.join(output, `${variant.name}-${scope}`);
    const start = performance.now();
    runCmdSync(
      process.execPath,
      [
        cli,
        '--config',
        '.jscpd-native.json',
        ...(scope === 'duo' ? pair : []),
        ...(scope === 'duo' ? ['--format', 'typescript'] : []),
        '--mode',
        variant.mode,
        '--min-tokens',
        String(variant.tokens),
        '--min-lines',
        String(variant.lines),
        ...variant.extra,
        '--workers',
        '2',
        '--absolute',
        '--reporters',
        'json',
        '--output',
        destination,
      ],
      { cwd: root },
    );
    const report: Report = JSON.parse(
      fs.readFileSync(path.join(destination, 'jscpd-report.json'), 'utf8'),
    );
    const { clones, duplicatedLines, percentage, sources } = report.statistics.total;
    const { fold, duoPanels } = countMotivatingClones(report.duplicates, duoRange);
    const row = {
      variant: variant.name,
      scope,
      sources,
      clones,
      duplicatedLines,
      percentage: Number(percentage.toFixed(2)),
      fold,
      duoPanels,
      milliseconds: Math.round(performance.now() - start),
    };
    rows.push(row);
    console.log(
      `${variant.name} ${scope}: ${clones} clones, ${row.percentage}%, Fold=${fold}, Duo panels=${duoPanels}, ${row.milliseconds}ms`,
    );
  }
}
fs.writeFileSync(path.join(output, 'summary.json'), `${JSON.stringify(rows, null, 2)}\n`);
console.log(`Reports: ${output}`);
