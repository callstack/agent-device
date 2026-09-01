const [derivedPath] = process.argv.slice(2);

if (!derivedPath) {
  console.error('Usage: patch-xcuitest-runner-icon.ts <derived>');
  process.exit(1);
}

const { applyXctestRunnerAppIconFromDerivedPath } =
  await import('@agent-device/platform-apple/runner/operations');
await applyXctestRunnerAppIconFromDerivedPath(derivedPath);
