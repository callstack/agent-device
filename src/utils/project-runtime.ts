import fs from 'node:fs';
import path from 'node:path';

export type ProjectRuntimeKind = 'auto' | 'react-native' | 'expo';

export type PackageJsonShape = {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

export function detectProjectRuntimeKind(cwd: string | undefined): ProjectRuntimeKind {
  const packageJson = readProjectPackageJson(cwd);
  if (!packageJson) return 'auto';
  return detectProjectRuntimeKindFromPackageJson(packageJson);
}

export function detectProjectRuntimeKindFromPackageJson(
  packageJson: PackageJsonShape,
): ProjectRuntimeKind {
  const dependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  if (typeof dependencies.expo === 'string') return 'expo';
  if (typeof dependencies['react-native'] === 'string') return 'react-native';
  return 'auto';
}

export function readProjectPackageJson(cwd: string | undefined): PackageJsonShape | undefined {
  if (!cwd) return undefined;
  const packageJsonPath = path.join(cwd, 'package.json');
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJsonShape;
  } catch {
    return undefined;
  }
}
