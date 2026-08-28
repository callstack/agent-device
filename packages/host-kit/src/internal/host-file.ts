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

export async function readHostTextFile(filePath: string): Promise<string> {
  return await fsPromises.readFile(filePath, 'utf8');
}

export async function readHostBinaryFile(filePath: string): Promise<Buffer> {
  return await fsPromises.readFile(filePath);
}

export async function removeHostDirectory(directoryPath: string): Promise<void> {
  await fsPromises.rm(directoryPath, { recursive: true, force: true });
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
