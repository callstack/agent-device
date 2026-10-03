import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function hostHomeDirectory(): string {
  return os.homedir();
}

export function hostTemporaryDirectory(): string {
  return os.tmpdir();
}

export async function makeHostTemporaryDirectory(prefix: string): Promise<string> {
  return await fsPromises.mkdtemp(path.join(hostTemporaryDirectory(), prefix));
}

export async function ensureHostDirectory(directoryPath: string): Promise<void> {
  await fsPromises.mkdir(directoryPath, { recursive: true });
}

export async function readHostTextFile(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  return await fsPromises.readFile(filePath, { encoding: 'utf8', signal: options.signal });
}

export async function readHostBinaryFile(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<Buffer> {
  return await fsPromises.readFile(filePath, { signal: options.signal });
}

export async function readHostDirectory(
  directoryPath: string,
  options: { withFileTypes: true },
): Promise<fs.Dirent[]>;
export async function readHostDirectory(
  directoryPath: string,
  options?: { withFileTypes?: false },
): Promise<string[]>;
export async function readHostDirectory(
  directoryPath: string,
  options: { withFileTypes?: boolean } = {},
): Promise<string[] | fs.Dirent[]> {
  if (options.withFileTypes === true) {
    return await fsPromises.readdir(directoryPath, { withFileTypes: true });
  }
  return await fsPromises.readdir(directoryPath);
}

export async function hostFileStat(filePath: string): Promise<fs.Stats> {
  return await fsPromises.stat(filePath);
}

export async function writeHostTextFile(filePath: string, contents: string): Promise<void> {
  await fsPromises.writeFile(filePath, contents, 'utf8');
}

export async function writeHostBinaryFile(filePath: string, contents: Uint8Array): Promise<void> {
  await fsPromises.writeFile(filePath, contents);
}

export async function removeHostPath(filePath: string): Promise<void> {
  await fsPromises.rm(filePath, { recursive: true, force: true });
}

export async function unlinkHostFile(filePath: string): Promise<void> {
  await fsPromises.unlink(filePath);
}

export async function copyHostFile(sourcePath: string, destinationPath: string): Promise<void> {
  await fsPromises.copyFile(sourcePath, destinationPath);
}

export async function copyHostPath(sourcePath: string, destinationPath: string): Promise<void> {
  await fsPromises.cp(sourcePath, destinationPath, { recursive: true });
}

export async function renameHostPath(sourcePath: string, destinationPath: string): Promise<void> {
  await fsPromises.rename(sourcePath, destinationPath);
}

export async function chmodHostFile(filePath: string, mode: number): Promise<void> {
  await fsPromises.chmod(filePath, mode);
}

export async function accessHostFile(filePath: string): Promise<void> {
  await fsPromises.access(filePath);
}

export async function removeHostDirectory(directoryPath: string): Promise<void> {
  await removeHostPath(directoryPath);
}

export function ensureHostDirectorySync(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export function readHostTextFileSync(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

export function writeHostTextFileSync(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, 'utf8');
}

export function hostFileExistsSync(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function hostFileStatSync(filePath: string): fs.Stats {
  return fs.statSync(filePath);
}

export function hostFileLstatSync(filePath: string): fs.Stats {
  return fs.lstatSync(filePath);
}

export function readHostSymbolicLinkSync(filePath: string): string {
  return fs.readlinkSync(filePath);
}

export function removeHostFileSync(filePath: string): void {
  fs.unlinkSync(filePath);
}

export function createHostDirectoryLinkSync(targetPath: string, linkPath: string): void {
  fs.symlinkSync(targetPath, linkPath, 'dir');
}

export function readHostDirectorySync(directoryPath: string): string[] {
  return fs.readdirSync(directoryPath);
}
