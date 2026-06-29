import { resolveDaemonPaths } from '../../daemon/config.ts';
import { AppError } from '../../kernel/errors.ts';
import { loginWithDeviceAuth, removeCliSession, summarizeCliSession } from '../auth-session.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const authCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  const subcommand = positionals[0] ?? 'status';
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  if (subcommand === 'status') {
    const status = summarizeCliSession({ stateDir });
    writeCommandOutput(flags, status, () => renderAuthStatus(status));
    return true;
  }
  if (subcommand === 'login') {
    const login = await loginWithDeviceAuth({
      stateDir,
      flags,
      commandLabel: 'agent-device auth login',
    });
    const data = {
      authenticated: true,
      source: 'cli-session',
      sessionId: login.session.id,
      cloudBaseUrl: login.session.cloudBaseUrl,
      workspaceId: login.session.workspaceId,
      accountId: login.session.accountId,
      expiresAt: login.session.expiresAt,
      agentTokenExpiresAt: login.expiresAt,
    };
    writeCommandOutput(flags, data, () => 'Authenticated with cloud CLI session.');
    return true;
  }
  if (subcommand === 'logout') {
    const removed = removeCliSession({ stateDir });
    writeCommandOutput(flags, { authenticated: false, removed }, () =>
      removed ? 'Removed stored cloud CLI session.' : 'No stored cloud CLI session.',
    );
    return true;
  }
  throw new AppError('INVALID_ARGS', 'auth accepts only: status, login, logout');
};

function renderAuthStatus(status: ReturnType<typeof summarizeCliSession>): string {
  if (!status.authenticated) return 'Not authenticated.';
  const lines = [
    'Authenticated with cloud CLI session.',
    `cloud=${status.cloudBaseUrl}`,
    `session=${status.sessionId}`,
    status.workspaceId ? `workspace=${status.workspaceId}` : null,
    status.accountId ? `account=${status.accountId}` : null,
    status.expiresAt ? `expiresAt=${status.expiresAt}` : null,
    status.expired ? 'status=expired' : null,
  ];
  return lines.filter((line): line is string => Boolean(line)).join('\n');
}
