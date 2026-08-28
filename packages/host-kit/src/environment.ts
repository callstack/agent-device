import os from 'node:os';
import process from 'node:process';

export function hostHomeDirectory(): string {
  return os.homedir();
}

export function hostTemporaryDirectory(): string {
  return os.tmpdir();
}

export function hostWorkingDirectory(): string {
  return process.cwd();
}

export function hostProcessId(): number {
  return process.pid;
}

export function hostPlatform(): NodeJS.Platform {
  return process.platform;
}

export function readHostEnvironmentVariable(name: string): string | undefined {
  return process.env[name];
}

export function writeHostStderr(value: string): void {
  process.stderr.write(value);
}
