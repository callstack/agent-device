// Content seal shared by the generator (regenerate.mjs) and the deterministic
// verifier (verify.ts).
//
// Normal CI cannot re-derive the fixtures — that needs Java, and "no Java in
// normal CI" is a design constraint. So per-PR verification recomputes this seal
// over the generated content: any hand edit to a captured command or constant
// changes the content and fails the check. That makes casual or accidental
// hand-editing impossible rather than merely discouraged.
//
// The seal is tamper-EVIDENT, not tamper-proof: someone could edit the content
// and recompute the hash. The scheduled `conformance-regenerate` job closes that
// hole for real by re-running the JVM harness against the pinned artifacts and
// failing on any byte difference — forgery cannot survive an actual re-derivation.
import { createHash } from 'node:crypto';

/**
 * Hash a fixture's generated content. The argument must NOT contain the seal
 * itself; `regenerate.mjs` appends `contentHash` last, so stripping that key
 * reproduces the exact object (and key order) that was hashed at write time.
 */
export function fixtureContentHash(fixtureWithoutSeal) {
  return createHash('sha256').update(JSON.stringify(fixtureWithoutSeal)).digest('hex');
}

/** Recompute a parsed fixture's seal. Returns the expected and recorded hashes. */
export function checkFixtureSeal(parsedFixture) {
  const { contentHash, ...content } = parsedFixture;
  return { expected: fixtureContentHash(content), actual: contentHash };
}
