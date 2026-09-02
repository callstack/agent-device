import { parseSync } from 'oxc-parser';
import { type LayeringViolation } from './model.ts';
import { propertyName, visitAst } from './layering-ast.ts';

export const PROVIDER_SNAPSHOT_PRESENTATION_RULE = 'R73 provider-snapshot-presentation-ownership';

export const WEBDRIVER_IOS_SNAPSHOT_ADAPTER =
  'packages/provider-webdriver/src/webdriver-ios-snapshot.ts';
export const LIMRUN_IOS_SNAPSHOT_ADAPTER = 'packages/provider-limrun/src/ios-snapshot-adapter.ts';
export const IOS_SNAPSHOT_PRESENTATION_OWNER = 'src/snapshot/ios-snapshot-runtime.ts';
export const SNAPSHOT_RUNTIME_HOST = 'src/snapshot/snapshot-desktop-surface.ts';

const ADAPTER_FILES = [WEBDRIVER_IOS_SNAPSHOT_ADAPTER, LIMRUN_IOS_SNAPSHOT_ADAPTER] as const;
const PRESENTATION_WIRING_FILES = [
  'packages/provider-webdriver/src/platform-runtime.ts',
  'packages/provider-limrun/src/app-log-runtime.ts',
] as const;
const FORBIDDEN_ADAPTER_IDENTIFIERS = new Set([
  'createIosSnapshotRequest',
  'deriveIosCaptureHint',
  'planIosSnapshot',
  'presentIosSnapshot',
  'publishIosSnapshot',
  'IosSnapshotEngineError',
  'toIosSnapshotEngineErrorDetails',
  'attachRefs',
  'stripRefs',
  'warningsForResidue',
]);

type AstNode = Record<string, unknown>;

export function providerSnapshotPresentationViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of ADAPTER_FILES) {
    const source = sources.get(file);
    if (source === undefined) {
      violations.push(violation(file, `${file} is missing from the provider acquisition boundary`));
      continue;
    }
    const program = parseSync(file, source).program;
    const forbidden = new Set<string>();
    visitAst(program, (node) => {
      if (node.type === 'Identifier' && FORBIDDEN_ADAPTER_IDENTIFIERS.has(String(node.name))) {
        forbidden.add(String(node.name));
      }
      if (node.type === 'Property' && propertyName(node.key) === 'ref') {
        forbidden.add('ref');
      }
    });
    for (const identifier of [...forbidden].sort()) {
      violations.push(
        violation(
          file,
          `provider acquisition adapter contains ${identifier}; presentation, warnings, and refs belong to ${IOS_SNAPSHOT_PRESENTATION_OWNER}`,
        ),
      );
    }
    if (!hasIdentifier(program, 'SnapshotRuntimeAcquiredResult')) {
      violations.push(
        violation(file, 'provider acquisition adapter must return SnapshotRuntimeAcquiredResult'),
      );
    }
    if (callCount(program, 'deriveIosSnapshotAcquisitionResidue') !== 1) {
      violations.push(
        violation(
          file,
          'provider acquisition adapter must derive its residue exactly once through the shared helper',
        ),
      );
    }
    if (!source.includes("stage: 'acquired'")) {
      violations.push(
        violation(file, 'provider acquisition adapter must return an acquired stage'),
      );
    }
  }

  const presentationOwner = sources.get(IOS_SNAPSHOT_PRESENTATION_OWNER);
  if (presentationOwner === undefined) {
    violations.push(
      violation(IOS_SNAPSHOT_PRESENTATION_OWNER, 'shared iOS presentation owner is missing'),
    );
  } else if (
    callCount(
      parseSync(IOS_SNAPSHOT_PRESENTATION_OWNER, presentationOwner).program,
      'presentIosSnapshot',
    ) !== 1
  ) {
    violations.push(
      violation(
        IOS_SNAPSHOT_PRESENTATION_OWNER,
        'shared iOS presentation owner must call presentIosSnapshot exactly once',
      ),
    );
  }

  const host = sources.get(SNAPSHOT_RUNTIME_HOST);
  if (host === undefined || !host.includes('presentIosSnapshotAcquisition')) {
    violations.push(
      violation(
        SNAPSHOT_RUNTIME_HOST,
        'snapshot runtime host must expose the shared iOS presentation owner',
      ),
    );
  }
  for (const file of PRESENTATION_WIRING_FILES) {
    if (!sources.get(file)?.includes('presentIosAcquisition')) {
      violations.push(
        violation(file, 'provider runtime must pass the host iOS presentation owner'),
      );
    }
  }
  return violations;
}

function callCount(program: unknown, name: string): number {
  let count = 0;
  visitAst(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode | undefined;
    if (callee?.type === 'Identifier' && callee.name === name) count += 1;
  });
  return count;
}

function hasIdentifier(program: unknown, name: string): boolean {
  let found = false;
  visitAst(program, (node) => {
    if (node.type === 'Identifier' && node.name === name) found = true;
  });
  return found;
}

function violation(file: string, message: string): LayeringViolation {
  return { rule: PROVIDER_SNAPSHOT_PRESENTATION_RULE, file, line: 1, message };
}
