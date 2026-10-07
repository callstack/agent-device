import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openVerifiedFileForRead, publishDurableFileSync } from '@agent-device/host-kit/file';
import { AppError } from '@agent-device/kernel/errors';

/** The one service credential Host v1 accepts (ADR 0021 §6), mapped to a server-controlled principal. */
export type HostServiceCredential = Readonly<{
  credentialId: string;
  token: string;
  principal: string;
  createdAt: string;
}>;

export type HostServiceCredentialLoad = Readonly<{
  credential: HostServiceCredential;
  credentialFile: string;
  created: boolean;
}>;

const CREDENTIAL_FILE_NAME = 'service-credential.json';
const CREDENTIAL_FILE_VERSION = 1;
const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{16}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const NON_EMPTY_PATTERN = /\S/;
const GROUP_OR_OTHER_ACCESS = 0o077;

function hostPrincipalForCredential(credentialId: string): string {
  return `host-svc-${credentialId}`;
}

/**
 * Returns the persisted credential, creating it on first start. An existing file is never
 * replaced: regenerating it would silently lock out every worker holding the old token.
 */
export function loadOrCreateHostServiceCredential(hostDir: string): HostServiceCredentialLoad {
  const credentialFile = path.join(hostDir, CREDENTIAL_FILE_NAME);
  ensurePrivateDirectory(hostDir);
  const existing = readCredential(credentialFile);
  if (existing) return { credential: existing, credentialFile, created: false };
  const credential = generateCredential();
  try {
    publishDurableFileSync({
      destination: credentialFile,
      contents: `${JSON.stringify({ version: CREDENTIAL_FILE_VERSION, ...credential }, null, 2)}\n`,
      mode: 0o600,
      publish: 'link-exclusive',
    });
  } catch (error) {
    const concurrent = isAlreadyExistsError(error) ? readCredential(credentialFile) : undefined;
    if (!concurrent) throw error;
    return { credential: concurrent, credentialFile, created: false };
  }
  return { credential, credentialFile, created: true };
}

function generateCredential(): HostServiceCredential {
  const credentialId = crypto.randomBytes(8).toString('hex');
  return {
    credentialId,
    token: crypto.randomBytes(32).toString('hex'),
    principal: hostPrincipalForCredential(credentialId),
    createdAt: new Date().toISOString(),
  };
}

function ensurePrivateDirectory(hostDir: string): void {
  fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(hostDir);
  if (!stat.isDirectory() || !isPrivateToCurrentUser(stat)) {
    throw insecureCredentialError(hostDir);
  }
}

function readCredential(credentialFile: string): HostServiceCredential | undefined {
  const descriptor = openVerifiedFileForRead(credentialFile);
  if (descriptor === undefined) return undefined;
  try {
    if (!isPrivateToCurrentUser(fs.fstatSync(descriptor))) {
      throw insecureCredentialError(credentialFile);
    }
    return parseCredential(fs.readFileSync(descriptor, 'utf8'), credentialFile);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseCredential(contents: string, credentialFile: string): HostServiceCredential {
  const credential = readCredentialFields(parseJsonRecord(contents));
  if (!credential) throw invalidCredentialError(credentialFile);
  return credential;
}

function parseJsonRecord(contents: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readCredentialFields(
  record: Record<string, unknown> | undefined,
): HostServiceCredential | undefined {
  if (record?.version !== CREDENTIAL_FILE_VERSION) return undefined;
  const credentialId = matchingString(record.credentialId, CREDENTIAL_ID_PATTERN);
  const token = matchingString(record.token, TOKEN_PATTERN);
  const createdAt = matchingString(record.createdAt, NON_EMPTY_PATTERN);
  if (!credentialId || !token || !createdAt) return undefined;
  const principal = hostPrincipalForCredential(credentialId);
  return record.principal === principal ? { credentialId, token, principal, createdAt } : undefined;
}

function matchingString(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function isPrivateToCurrentUser(stat: fs.Stats): boolean {
  const uid = process.getuid?.();
  return (stat.mode & GROUP_OR_OTHER_ACCESS) === 0 && (uid === undefined || stat.uid === uid);
}

function insecureCredentialError(target: string): AppError {
  return new AppError('COMMAND_FAILED', 'Host service credential is not private to this user.', {
    reason: 'host-credential-insecure',
    path: target,
    hint: `Make ${target} owned by the Host user and inaccessible to group and others (chmod 700 for the directory, 600 for the file).`,
  });
}

function invalidCredentialError(credentialFile: string): AppError {
  return new AppError('COMMAND_FAILED', 'Host service credential file is malformed.', {
    reason: 'host-credential-invalid',
    path: credentialFile,
    hint: `Delete ${credentialFile} to create a new credential. Workers then need the new token.`,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}
