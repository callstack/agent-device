/**
 * Decoding one segment of an HTTP request target, shared by the daemon's
 * auxiliary routes (`/artifacts/*`, the request diagnostics route).
 *
 * A route that decoded ids its own way would disagree with its siblings about
 * what a request addresses, and an id that fails to decode must resolve to a
 * name no record can have rather than throwing inside the dispatcher.
 */

/** The decoded segment, or `''` when it is not decodable — never a throw. */
export function decodeUriSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}
