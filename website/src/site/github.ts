// The repository's GitHub star count. Pages read it once per build, so the header renders the
// figure without scripts; GitHubStars.astro refreshes it in the browser. GitHub allows 60
// unauthenticated requests an hour per IP, so a build sends GITHUB_TOKEN when it is set, and
// gets undefined when GitHub is unreachable or refuses. No imports: the browser script uses it.

/** The GitHub API URL for a repository URL. */
export const starsApi = (repo: string) =>
  repo.replace('https://github.com/', 'https://api.github.com/repos/');

/** Reads `stargazers_count` from a GitHub repository response. */
export async function readStars(response: Response): Promise<number | undefined> {
  if (!response.ok) return undefined;
  const { stargazers_count: stars } = (await response.json()) as { stargazers_count?: unknown };
  return typeof stars === 'number' ? stars : undefined;
}

let atBuild: Promise<number | undefined> | undefined;

/** The count when the site is built, fetched once however many pages render the header. */
export function buildStars(repo: string): Promise<number | undefined> {
  const token = process.env.GITHUB_TOKEN;
  atBuild ??= fetch(starsApi(repo), {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(5000),
  })
    .then(readStars)
    .catch(() => undefined);
  return atBuild;
}

/** As GitHub shows it: 5170 is "5.2K", 812 is "812". */
export const formatStars = (stars: number) =>
  new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(stars);
