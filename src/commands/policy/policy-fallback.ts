/**
 * The documented recovery when the policy head cannot answer. It names the agent's own loop
 * because that loop is always available: the policy head is an accelerator, never a dependency.
 *
 * It lives apart from both the provider and the composer so either can name it without one
 * importing the other.
 */
export const POLICY_FALLBACK_HINT =
  'fall back to agent-driven policy: snapshot, choose an element yourself, then press or fill it.';
