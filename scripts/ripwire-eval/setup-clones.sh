#!/usr/bin/env bash
# Cuts one leak-free clone per task, pinned at the commit's PARENT, and proves the fix commit is
# unreachable from each.
#
# A shallow fetch of the parent SHA is what makes the clone leak-free: a `git worktree` shares
# .git with the main checkout, so the commit the agent is asked to predict would be one
# `git log --all` away. The fetch must name the FULL sha — git refuses to fetch an abbreviated
# one — which is why tasks.json carries full SHAs.
#
# Usage: scripts/ripwire-eval/setup-clones.sh [<dest>]   (default: /tmp/rw)

set -euo pipefail

dest="${1:-/tmp/rw}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"

read_tasks() {
  node -e '
    const tasks = require(process.argv[1]).tasks;
    for (const t of tasks) console.log([t.id, t.parent, t.commit].join(" "));
  ' "$here/tasks.json"
}

while read -r id parent commit; do
  rm -rf "${dest:?}/$id"
  mkdir -p "$dest/$id"
  git -C "$dest/$id" init -q
  git -C "$dest/$id" remote add origin "$repo"
  git -C "$dest/$id" fetch -q --no-tags --depth=20 origin "$parent"
  git -C "$dest/$id" checkout -q --detach "$parent"

  if git -C "$dest/$id" cat-file -e "$commit^{commit}" 2>/dev/null; then
    echo "$id LEAKS ${commit:0:9} — refusing to hand an agent the answer" >&2
    exit 1
  fi
  echo "$id pinned at ${parent:0:9}, ${commit:0:9} unreachable"
done < <(read_tasks)
