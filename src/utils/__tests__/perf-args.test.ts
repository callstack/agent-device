import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs, usageForCommand } from '../args.ts';

test('parseArgs accepts perf area subcommands', () => {
  const metrics = parseArgs(['perf', 'metrics'], { strictFlags: true });
  assert.equal(metrics.command, 'perf');
  assert.deepEqual(metrics.positionals, ['metrics']);

  const frames = parseArgs(['perf', 'frames'], { strictFlags: true });
  assert.equal(frames.command, 'perf');
  assert.deepEqual(frames.positionals, ['frames']);

  const memory = parseArgs(['perf', 'memory', 'snapshot', '--kind', 'memgraph'], {
    strictFlags: true,
  });
  assert.equal(memory.command, 'perf');
  assert.deepEqual(memory.positionals, ['memory', 'snapshot']);
  assert.equal(memory.flags.kind, 'memgraph');

  const profile = parseArgs(
    ['perf', 'cpu', 'profile', 'start', '--kind', 'xctrace', '--out', 'app.trace'],
    { strictFlags: true },
  );
  assert.equal(profile.command, 'perf');
  assert.deepEqual(profile.positionals, ['cpu', 'profile', 'start']);
  assert.equal(profile.flags.kind, 'xctrace');
  assert.equal(profile.flags.out, 'app.trace');
});

test('usageForCommand advertises perf area subcommands for metrics alias', () => {
  const help = usageForCommand('metrics');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device perf metrics --json/);
  assert.match(help ?? '', /agent-device perf frames --json/);
  assert.match(help ?? '', /perf memory snapshot/);
  assert.match(help ?? '', /perf cpu profile report --kind xctrace --out <report\.json>/);
  assert.match(help ?? '', /perf cpu profile report --kind simpleperf --out <cpu-report\.json>/);
});
