#!/usr/bin/env bash
# Shared trusted-artifact retrieval for the fixture-app platform adapters.
set -euo pipefail

PLATFORM="${1:?platform is required}"
DEST="${2:?destination is required}"
WAIT_SECONDS="${3:?wait duration is required}"
REPOSITORY="${4:?repository is required}"
EXPECTED_HEAD_SHA="${5:?expected head SHA is required}"
ACTION_PATH="${6:?action path is required}"
REQUIRE_ARTIFACT="${7:-false}"

NAME="$(sh "$ACTION_PATH/resolve-artifact-name.sh" "$PLATFORM")"
TRUSTED_ARTIFACT="$ACTION_PATH/trusted-artifact.mjs"
rm -rf "$DEST"; mkdir -p "$DEST"
case "$WAIT_SECONDS" in
  ''|*[!0-9]*)
    echo "::error::wait-for-artifact-seconds must be a non-negative integer."
    exit 1
    ;;
esac
case "$REQUIRE_ARTIFACT" in
  true|false) ;;
  *)
    echo "::error::require-artifact must be true or false."
    exit 1
    ;;
esac

# A lookup failure (API outage, auth, transient 5xx) must not fail the caller
# or trigger a pointless wait: it takes the inline-build path.
query_artifact() {
  node "$TRUSTED_ARTIFACT" find "$REPOSITORY" "$NAME" "$EXPECTED_HEAD_SHA" 2>/dev/null
}
query_producer_state() {
  node "$TRUSTED_ARTIFACT" producer-state "$REPOSITORY" "$EXPECTED_HEAD_SHA" 2>/dev/null
}
if ! ART_ID="$(query_artifact)"; then
  echo "::warning::Could not query the build cache for $NAME; building inline."
  ART_ID=""
  WAIT_SECONDS=0
fi
if [ -z "$ART_ID" ] && [ "$WAIT_SECONDS" -gt 0 ]; then
  DEADLINE=$((SECONDS + WAIT_SECONDS))
  MISSING_PRODUCER_POLLS=0
  echo "$NAME is not available; waiting up to ${WAIT_SECONDS}s for its producer."
  while [ -z "$ART_ID" ] && [ "$SECONDS" -lt "$DEADLINE" ]; do
    if ! PRODUCER_STATE="$(query_producer_state)"; then
      echo "::warning::Could not inspect the fixture producer; building inline."
      break
    fi
    case "$PRODUCER_STATE" in
      queued)
        echo "Fixture producer is queued; building inline instead of waiting for a native runner."
        break
        ;;
      failed)
        echo "Fixture producer failed; building inline."
        break
        ;;
      success)
        echo "Fixture producer completed without $NAME; building inline."
        break
        ;;
      absent)
        MISSING_PRODUCER_POLLS=$((MISSING_PRODUCER_POLLS + 1))
        if [ "$MISSING_PRODUCER_POLLS" -ge 3 ]; then
          echo "No fixture producer appeared for $EXPECTED_HEAD_SHA; building inline."
          break
        fi
        ;;
      in_progress)
        MISSING_PRODUCER_POLLS=0
        ;;
      *)
        echo "::warning::Fixture producer returned unknown state '$PRODUCER_STATE'; building inline."
        break
        ;;
    esac
    sleep 30
    if ! ART_ID="$(query_artifact)"; then
      echo "::warning::Build cache polling failed for $NAME; building inline."
      ART_ID=""
      break
    fi
  done
fi

SOURCE=build
if [ -n "$ART_ID" ]; then
  STAGE="$(mktemp -d)"
  # Any failure along the download path falls through to an inline build rather
  # than failing the caller.
  if gh api "repos/${REPOSITORY}/actions/artifacts/${ART_ID}/zip" > "$STAGE/a.zip" \
     && unzip -q "$STAGE/a.zip" -d "$STAGE" \
     && tar -xzf "$STAGE/binary.tar.gz" -C "$DEST"; then
    SOURCE=artifact
    echo "restored $NAME from the build cache"
  else
    if [ "$REQUIRE_ARTIFACT" = true ]; then
      echo "::error::Could not restore required fixture artifact $NAME."
      exit 1
    fi
    echo "::warning::Could not restore $NAME; building inline."
    rm -rf "$DEST"/*
  fi
  rm -rf "$STAGE"
else
  if [ "$REQUIRE_ARTIFACT" = true ]; then
    echo "::error::Required fixture artifact $NAME is unavailable for this exact head."
    exit 1
  fi
  echo "$NAME not in the cache after the configured wait; building inline."
fi
echo "source=$SOURCE" >> "$GITHUB_OUTPUT"
