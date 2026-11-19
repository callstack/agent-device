/**
 * The one owner of the daemon's HTTP ingress budgets (#4441).
 *
 * Node starts its request clock when the parser starts a message, and it checks header
 * and request expiry only once per connections-checking interval. A header block can
 * therefore reach the request callback up to one interval after the header ceiling, and
 * the request ceiling can fire up to one interval early relative to admission. The upload
 * owner starts its aggregate at admission, so the native request ceiling covers the worst
 * admitted header time, one polling interval, the upload aggregate, and a margin. Node
 * then never closes an upload body that is still inside its own budget.
 */
export const DAEMON_HTTP_HEADERS_TIMEOUT_MS = 30_000;
export const DAEMON_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS = 5_000;
/** The upload aggregate from request admission through finalization. */
export const UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS = 600_000;
export const UPLOAD_AGGREGATE_SOCKET_MARGIN_MS = 30_000;

/** The native request ceiling that stays behind every admitted upload's own aggregate. */
export function requestTimeoutBehindUploads(budget: {
  headersTimeoutMs: number;
  connectionsCheckingIntervalMs: number;
  uploadAggregateMs: number;
  marginMs: number;
}): number {
  return (
    budget.headersTimeoutMs +
    budget.connectionsCheckingIntervalMs +
    budget.uploadAggregateMs +
    budget.marginMs
  );
}
