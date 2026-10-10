// Codemod: insert `createCommandSurface: testCreateCommandSurface,` into object literals
// reported by tsc as missing the required port, and add the fixture import.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)(
  new URL('./node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/lib/typescript.js', `file://${process.cwd()}/`).pathname,
);

const ROOT = process.cwd();
const FIXTURE = 'src/daemon/__tests__/command-surface-fixture.ts';
const PROP = 'createCommandSurface';
const VALUE = 'testCreateCommandSurface';

const errLines = fs
  .readFileSync(process.argv[2], 'utf8')
  .split('\n')
  .filter((l) => /error TS(2741|2345)/.test(l) || /error TS2322/.test(l));

const byFile = new Map();
for (const line of errLines) {
  const m = line.match(/^(.+?)\((\d+),(\d+)\): error TS(\d+)/);
  if (!m) continue;
  const [, file, row, col, code] = m;
  if (!/(^|\/)(__tests__|test)\//.test(file) && !file.includes('.test.ts')) continue;
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push({ row: +row, col: +col, code: +code });
}

let insertions = 0;
const changedFiles = new Set();
const notes = [];

for (const [relFile, errs] of byFile) {
  const abs = path.join(ROOT, relFile);
  if (!fs.existsSync(abs)) {
    notes.push(`MISSING ${relFile}`);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  const src = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const lineStarts = ts.computeLineStarts(text);
  const literals = [];
  (function walk(node) {
    if (ts.isObjectLiteralExpression(node)) literals.push(node);
    node.forEachChild(walk);
  })(src);

  const starts = new Set();
  for (const e of errs) {
    const pos = lineStarts[e.row - 1] + e.col - 1;
    let cands = literals
      .filter((lit) => lit.getStart(src) <= pos && lit.getEnd() >= pos)
      .sort((a, b) => b.getStart(src) - a.getStart(src));
    if (cands.length === 0) {
      const lineEnd = lineStarts[e.row] ?? text.length;
      cands = literals
        .filter((lit) => lit.getStart(src) >= pos && lit.getStart(src) < lineEnd)
        .sort((a, b) => a.getStart(src) - b.getStart(src));
    }
    if (cands.length === 0) {
      notes.push(`NO-LITERAL ${relFile} ${e.row} ${e.col} TS${e.code}`);
      continue;
    }
    const lit = cands[0];
    if (lit.properties.some((p) => p.name && p.name.getText(src) === PROP)) continue;
    starts.add(lit.getStart(src));
  }
  if (starts.size === 0) continue;

  let out = text;
  const edits = [];
  for (const start of starts) {
    const lit = literals.find((l) => l.getStart(src) === start);
    const first = lit.properties[0];
    let indent = '  ';
    if (first) {
      const ls = text.lastIndexOf('\n', first.getStart(src)) + 1;
      const m = text.slice(ls, first.getStart(src)).match(/[ \t]*$/);
      if (m && m[0]) indent = m[0];
    }
    const insertion = `\n${indent}${PROP}: ${VALUE},`;
    const at = first ? first.getStart(src) : lit.getStart(src) + 1;
    edits.push({ at, insertion });
    insertions += 1;
  }
  edits.sort((a, b) => b.at - a.at);
  for (const e of edits) out = out.slice(0, e.at) + e.insertion + out.slice(e.at);

  if (!new RegExp(`import\\s*\\{[^}]*\\b${VALUE}\\b[^}]*\\}`).test(out)) {
    const rel = path
      .relative(path.dirname(abs), path.join(ROOT, FIXTURE))
      .replace(/\\/g, '/');
    const spec = rel.startsWith('.') ? rel : './' + rel;
    const imp = `import { ${VALUE} } from '${spec}';`;
    const tmp = ts.createSourceFile(abs, out, ts.ScriptTarget.Latest, true);
    let lastImportEnd = 0;
    for (const st of tmp.statements) {
      if (ts.isImportDeclaration(st)) lastImportEnd = st.getEnd();
      else break;
    }
    if (lastImportEnd > 0) out = out.slice(0, lastImportEnd) + '\n' + imp + out.slice(lastImportEnd);
    else out = imp + '\n' + out;
  }
  fs.writeFileSync(abs, out);
  changedFiles.add(relFile);
}
console.log('FILES', changedFiles.size, 'INSERTIONS', insertions);
for (const n of notes) console.log(n);
