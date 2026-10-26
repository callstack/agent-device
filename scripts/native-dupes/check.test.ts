import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCmdSync } from '@agent-device/host-kit/command';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'node_modules/jscpd/run-jscpd.js');
const { scripts } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gateArgs: string[] = scripts['check:native-dupes'].split(' ').slice(1);
const baselineArgs: string[] = scripts['native-dupes:baseline'].split(' ').slice(1);

type Report = {
  statistics: { total: { clones: number; newClones: number } };
  duplicates: Array<{ format: string; isNew: boolean }>;
};

function fixture() {
  const cwd = mkdtempForTestSync('native-dupes-');
  runCmdSync('git', ['init', '-q'], { cwd });
  fs.copyFileSync(path.join(root, '.jscpd-native.json'), path.join(cwd, '.jscpd-native.json'));
  for (const dir of ['apple', 'android', 'linux']) fs.mkdirSync(path.join(cwd, dir));
  const write = (file: string, source: string) => fs.writeFileSync(path.join(cwd, file), source);
  const run = (args = gateArgs) => {
    const result = runCmdSync(
      process.execPath,
      [cli, ...args, '--workers', '1', '--reporters', 'json'],
      {
        cwd,
        allowFailure: true,
      },
    );
    const reportPath = path.join(cwd, '.tmp/native-dupes/jscpd-report.json');
    const report: Report | undefined = fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, 'utf8'))
      : undefined;
    return { ...result, report };
  };
  return { cwd, write, run };
}

const sources = [
  {
    file: 'apple/Capture.swift',
    format: 'swift',
    source: `
func captureWindow(_ frames: [Int]) -> Int {
  var total = 0
  for frame in frames {
    let bounded = max(0, frame)
    let scaled = bounded * 17
    total += scaled
    if scaled > 100 {
      total -= 3
    }
  }
  print("captured window", total)
  return total
}
`,
  },
  {
    file: 'apple/Capture.m',
    format: 'objectivec',
    source: `
int captureWindow(int count) {
  int total = 0;
  for (int frame = 0; frame < count; frame++) {
    int bounded = MAX(0, frame);
    int scaled = bounded * 19;
    total += scaled;
    if (scaled > 110) {
      total -= 5;
    }
  }
  NSLog(@"captured panel %d", total);
  return total;
}
`,
  },
  {
    file: 'android/Capture.java',
    format: 'java',
    source: `
class Capture {
  static int captureWindow(int count) {
    int total = 0;
    for (int frame = 0; frame < count; frame++) {
      int bounded = Math.max(0, frame);
      int scaled = bounded * 23;
      total += scaled;
      if (scaled > 120) {
        total -= 7;
      }
    }
    System.out.println("captured view " + total);
    return total;
  }
}
`,
  },
  {
    file: 'android/Capture.kt',
    format: 'kotlin',
    source: `
fun captureWindow(frames: List<Int>): Int {
  var total = 0
  for (frame in frames) {
    val bounded = maxOf(0, frame)
    val scaled = bounded * 29
    total += scaled
    if (scaled > 130) {
      total -= 11
    }
  }
  println("captured activity: $total")
  return total
}
`,
  },
  {
    file: 'linux/capture.py',
    format: 'python',
    source: `
def capture_window(frames):
    total = 0
    for frame in frames:
        bounded = max(0, frame)
        scaled = bounded * 31
        total += scaled
        if scaled > 140:
            total -= 13
        else:
            total += 17
    print("captured surface", total)
    return total
`,
  },
];

for (const { file, format, source } of sources) {
  test(`the gate rejects a new ${format} clone of an unchanged file`, () => {
    const { write, run } = fixture();
    write(file, source);
    const baseline = run(baselineArgs);
    assert.equal(baseline.exitCode, 0, baseline.stderr);
    assert.equal(baseline.report?.statistics.total.clones, 0);
    write(file.replace('.', '-copy.'), source);
    const result = run();
    assert.equal(result.exitCode, 1, result.stdout + result.stderr);
    assert.ok(result.report?.duplicates.some((clone) => clone.format === format && clone.isNew));
  });
}

test('a header clone is analyzed as Objective-C', () => {
  const { write, run } = fixture();
  write('apple/Geometry.h', sources[1]!.source);
  assert.equal(run(baselineArgs).exitCode, 0);
  write('apple/GeometryCopy.h', sources[1]!.source);
  const result = run();
  assert.equal(result.exitCode, 1);
  assert.ok(
    result.report?.duplicates.some((clone) => clone.format === 'objectivec' && clone.isNew),
  );
});

test('baseline accepts line shifts, rejects extra copies and replacement clones at the same count', () => {
  const { cwd, write, run } = fixture();
  const source = sources[0]!.source;
  write('apple/Capture.swift', source);
  write('apple/Copy.swift', source);
  assert.equal(run(baselineArgs).exitCode, 0);
  assert.equal(run().exitCode, 0);
  write('apple/Copy.swift', `// A shifted copy.\n\n${source}`);
  assert.equal(run().exitCode, 0);
  write('apple/Third.swift', source);
  assert.equal(run().exitCode, 1, 'a third copy must exceed the fingerprint count');
  fs.unlinkSync(path.join(cwd, 'apple/Third.swift'));
  const replacement = source.replace('17', '37');
  write('apple/Capture.swift', replacement);
  write('apple/Copy.swift', replacement);
  const changed = run();
  assert.equal(changed.report?.statistics.total.clones, 1);
  assert.equal(changed.report?.statistics.total.newClones, 1);
  assert.equal(changed.exitCode, 1, 'unchanged total count must not hide a different clone');
});

test('the gate rejects a missing baseline and an empty scan', () => {
  const { write, run } = fixture();
  write('apple/Capture.swift', sources[0]!.source);
  assert.equal(run().exitCode, 1, 'a missing baseline must not become a report-only scan');
  assert.equal(run(baselineArgs).exitCode, 0);
  write('apple/Capture.swift', '// No executable tokens.\n');
  assert.equal(run().exitCode, 1, 'a format or scope mistake must not silently pass');
});

test('same-file clones fail while comment blocks and ignored build outputs do not', () => {
  const { cwd, write, run } = fixture();
  const source = sources[0]!.source;
  write('apple/Capture.swift', source);
  assert.equal(run(baselineArgs).exitCode, 0);
  write('apple/Capture.swift', `${source}\n${source.replace('captureWindow', 'captureDisplay')}`);
  assert.equal(run().exitCode, 1, 'copies within one file must remain in scope');
  write('apple/Capture.swift', source);
  const comment = `/*\n${'Repeated documentation without executable code.\n'.repeat(30)}*/\n`;
  write('apple/Notes.swift', comment);
  write('apple/OtherNotes.swift', comment);
  write('.gitignore', 'apple/build/\n');
  fs.mkdirSync(path.join(cwd, 'apple/build'));
  write('apple/build/Generated.swift', source);
  assert.equal(run().exitCode, 0, 'comments and ignored generated copies must not add clones');
});
