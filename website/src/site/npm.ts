// npm downloads of agent-device over the last 30 days, read when the site is built. The site
// redeploys on every push to main, so the figure stays current. Uses an explicit date range:
// npm's `last-month` endpoint can serve a stale window. Returns undefined when npm is
// unreachable, and the page leaves the figure out.

const DAY = 24 * 60 * 60 * 1000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

let atBuild: Promise<number | undefined> | undefined;

/** Fetched once per build, however many components show the figure. */
export function monthlyDownloads(): Promise<number | undefined> {
  atBuild ??= fetchDownloads();
  return atBuild;
}

async function fetchDownloads(): Promise<number | undefined> {
  const end = Date.now() - DAY;
  const range = `${day(end - 29 * DAY)}:${day(end)}`;
  try {
    const response = await fetch(`https://api.npmjs.org/downloads/point/${range}/agent-device`, {
      signal: AbortSignal.timeout(5000),
    });
    const { downloads } = (await response.json()) as { downloads?: number };
    return response.ok && typeof downloads === 'number' ? downloads : undefined;
  } catch {
    return undefined;
  }
}

/** Rounded down, so the figure never overstates: 1018444 is "1M+", 246586 is "246k+", 812 is "812+". */
export function compact(n: number): string {
  if (n >= 1e6) return `${Math.floor(n / 1e6)}M+`;
  return n >= 1e3 ? `${Math.floor(n / 1e3)}k+` : `${n}+`;
}
