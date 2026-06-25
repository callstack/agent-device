import fs from 'node:fs';
import path from 'node:path';

export type ProjectRuntimeKind = 'auto' | 'react-native' | 'expo';

type PackageJsonShape = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export function detectProjectRuntimeKind(cwd: string | undefined): ProjectRuntimeKind {
  const packageJson = readPackageJson(cwd);
  if (!packageJson) return 'auto';

  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  if (typeof dependencies.expo === 'string') return 'expo';
  if (typeof dependencies['react-native'] === 'string') return 'react-native';
  return 'auto';
}

function readPackageJson(cwd: string | undefined): PackageJsonShape | undefined {
  if (!cwd) return undefined;
  const packageJsonPath = path.join(cwd, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}
