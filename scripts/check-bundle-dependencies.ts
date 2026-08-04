import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { walkFiles } from './lib/walk-files.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(repoRoot, 'dist', 'src');

function moduleSpecifiers(file: string, source: string): string[] {
  const record = parseSync(file, source).module;
  return [
    ...record.staticImports.map((entry) => entry.moduleRequest.value),
    ...record.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) => moduleRequestValue(exported.moduleRequest)),
    ),
    ...record.dynamicImports.flatMap((entry) =>
      dynamicModuleRequestValue(source, entry.moduleRequest),
    ),
  ];
}

function moduleRequestValue(request: { value?: string } | undefined): string[] {
  return request?.value ? [request.value] : [];
}

function dynamicModuleRequestValue(
  source: string,
  request: { start: number; end: number },
): string[] {
  const raw = source.slice(request.start, request.end);
  const literal = /^(['"])([^'"]*)\1$/.exec(raw);
  return literal?.[2] ? [literal[2]] : [];
}

const bundleFiles = walkFiles(distRoot).filter(
  (file) => file.endsWith('.js') || file.endsWith('.d.ts'),
);
if (bundleFiles.length === 0) {
  throw new Error('No dist/src JavaScript files found. Run `pnpm build` first.');
}

const leaks = bundleFiles.flatMap((file) => {
  const source = fs.readFileSync(file, 'utf8');
  return moduleSpecifiers(file, source)
    .filter((specifier) => specifier.startsWith('@agent-device/'))
    .map((specifier) => ({ file: path.relative(repoRoot, file), specifier }));
});

if (leaks.length > 0) {
  const details = leaks.map(({ file, specifier }) => `- ${specifier} in ${file}`).join('\n');
  throw new Error(
    `Private workspace dependencies escaped the production bundle:\n${details}\n` +
      'Published installs cannot resolve private @agent-device packages.',
  );
}

process.stdout.write(
  `Verified ${bundleFiles.length} production module files contain no private workspace imports.\n`,
);
