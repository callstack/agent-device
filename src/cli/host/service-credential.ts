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
  /** True when this start generated the credential; it reaches disk only through `publish`. */
  created: boolean;
  /**
   * Writes a generated credential. Host calls it once it is serving, so a start that fails
   * earlier leaves no credential behind and the next start shows the token it creates.
   */
  publish(): void;
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
 * Returns the persisted credential, or a new one to publish once Host is serving. An existing
 * file is never replaced: regenerating it would silently lock out every worker holding the token.
 */
export function prepareHostServiceCredential(hostDir: string): HostServiceCredentialLoad {
  const credentialFile = path.join(hostDir, CREDENTIAL_FILE_NAME);
  ensurePrivateDirectory(hostDir);
  const existing = readCredential(credentialFile);
  if (existing) {
    return { credential: existing, credentialFile, created: false, publish: () => {} };
  }
  const credential = generateCredential();
  return {
    credential,
    credentialFile,
    created: true,
    publish: () => publishCredential(credentialFile, credential),
  };
}

function publishCredential(credentialFile: string, credential: HostServiceCredential): void {
  try {
    publishDurableFileSync({
      destination: credentialFile,
      contents: `${JSON.stringify({ version: CREDENTIAL_FILE_VERSION, ...credential }, null, 2)}\n`,
      mode: 0o600,
      publish: 'link-exclusive',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error;
    throw new AppError(
      'COMMAND_FAILED',
      'Another Host start created the service credential first.',
      {
        reason: 'host-credential-raced',
        path: credentialFile,
        hint: 'Run one Host per state dir, then restart this Host to use the stored credential.',
      },
    );
  }
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
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw insecureCredentialError(hostDir, `${hostDir} must be a real directory, not a link.`);
  }
  if (!isPrivateToCurrentUser(stat)) throw insecureCredentialError(hostDir, privateHint(hostDir));
}

function readCredential(credentialFile: string): HostServiceCredential | undefined {
  const descriptor = openCredentialFile(credentialFile);
  if (descriptor === undefined) return undefined;
  try {
    if (!isPrivateToCurrentUser(fs.fstatSync(descriptor))) {
      throw insecureCredentialError(credentialFile, privateHint(credentialFile));
    }
    return parseCredential(fs.readFileSync(descriptor, 'utf8'), credentialFile);
  } finally {
    fs.closeSync(descriptor);
  }
}

function openCredentialFile(credentialFile: string): number | undefined {
  try {
    return openVerifiedFileForRead(credentialFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError(
        'COMMAND_FAILED',
        'Host service credential file is not readable.',
        {
          reason: 'host-credential-unreadable',
          path: credentialFile,
          hint: `Make ${credentialFile} readable by the Host user (chmod 600).`,
        },
        error,
      );
    }
    throw insecureCredentialError(
      credentialFile,
      `${credentialFile} must be a regular file, not a link or directory.`,
    );
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

/** Platforms without POSIX ownership (no getuid) report synthetic mode bits, so only POSIX checks them. */
function isPrivateToCurrentUser(stat: fs.Stats): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return true;
  return (stat.mode & GROUP_OR_OTHER_ACCESS) === 0 && stat.uid === uid;
}

function privateHint(target: string): string {
  return `Make ${target} owned by the Host user and inaccessible to group and others (chmod 700 for the directory, 600 for the file).`;
}

function insecureCredentialError(target: string, hint: string): AppError {
  return new AppError('COMMAND_FAILED', 'Host service credential is not private to this user.', {
    reason: 'host-credential-insecure',
    path: target,
    hint,
  });
}

function invalidCredentialError(credentialFile: string): AppError {
  return new AppError('COMMAND_FAILED', 'Host service credential file is malformed.', {
    reason: 'host-credential-invalid',
    path: credentialFile,
    hint: `Delete ${credentialFile} to create a new credential. Workers then need the new token.`,
  });
}
