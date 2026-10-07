#!/bin/bash
# Background updater for the personal MonoCode fork.
# Started by the `monocode` launcher every time MonoCode opens. It:
#   1. merges new upstream commits into `mine` (an agent fixes conflicts or a broken build),
#   2. runs the tests and builds the app,
#   3. stages the new app; the launcher swaps it in on the next open.
# All work happens in a private worktree, so the main checkout is never reset or rewritten.
# `mine` only moves forward, and only if nobody moved it during the run.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.local/state/monocode-fork"
WORK="$STATE/work"
STAGED="$STATE/MonoCode.app"
LOG="$STATE/update.log"
LOCK="$STATE/update.lock"
BUILT_SHA="$STATE/built-sha"
BRANCH=mine
UPSTREAM=upstream/main
AGENT_MODEL=claude-sonnet-5-5

mkdir -p "$STATE"
exec >>"$LOG" 2>&1
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Upstream's tests assume a US locale and Node without its own localStorage (CI runs Node 20/24);
# without these, 325 tests fail on a clean checkout under Node 26 in en_AU.
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
export NODE_OPTIONS="--no-experimental-webstorage${NODE_OPTIONS:+ $NODE_OPTIONS}"
# Share the Rust build cache with the main checkout so builds stay incremental.
export CARGO_TARGET_DIR="$REPO/target"

log()
{
    echo "[$(date '+%F %T')] $*"
}

notify()
{
    osascript -e "display notification \"$1\" with title \"MonoCode fork\"" >/dev/null 2>&1
}

# One run at a time. The lock holds the owner's PID; it is only taken over when that process is gone.
if ! mkdir "$LOCK" 2>/dev/null; then
    owner="$(cat "$LOCK/pid" 2>/dev/null)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
        exit 0
    fi
    rm -rf "$LOCK"
    mkdir "$LOCK" || exit 0
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

cd "$REPO" || exit 1
log "start"

git fetch --quiet upstream || { log "skip: fetch failed (offline?)"; exit 0; }

before="$(git rev-parse "refs/heads/$BRANCH")"
upstream_new=0
if ! git merge-base --is-ancestor "$UPSTREAM" "$before"; then
    upstream_new=1
fi
if [ "$upstream_new" = 0 ] && [ -f "$BUILT_SHA" ] && [ "$(cat "$BUILT_SHA")" = "$before" ]; then
    log "up to date (${before:0:7})"
    exit 0
fi

# Fresh private worktree on a detached copy of `mine`.
if [ -d "$WORK" ]; then
    git -C "$WORK" merge --abort 2>/dev/null
    git -C "$WORK" checkout --quiet --force --detach "$before" && git -C "$WORK" clean -fdq -e node_modules
else
    git worktree prune
    git worktree add --quiet --detach "$WORK" "$before"
fi || { log "could not prepare worktree"; exit 1; }
cd "$WORK" || exit 1

run_agent()
{
    # $1 = task. The agent works only in the private worktree.
    claude -p "$1" \
        --model "$AGENT_MODEL" --effort low \
        --permission-mode acceptEdits \
        --allowedTools "Read" "Edit" "Write" "Grep" "Glob" \
            "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(cargo:*)" \
        --append-system-prompt "You are the unattended updater for a personal fork of MonoCode, working in $WORK. Keep the fork's own features working and take upstream's changes. Never push, never touch files outside $WORK, never delete fork/. If you cannot finish safely, say FAILED and stop."
}

if [ "$upstream_new" = 1 ]; then
    log "merging $(git rev-list --count HEAD.."$UPSTREAM") upstream commits"
    if ! git merge --quiet --no-edit "$UPSTREAM"; then
        log "conflicts: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
        run_agent "A git merge of $UPSTREAM into the fork stopped with conflicts. Resolve every conflict so both upstream's change and the fork's change keep working, then run 'npx tsc --noEmit' and 'npm test', fix what you broke, and finish with 'git add -A && git commit --no-edit'."
        if [ -n "$(git diff --name-only --diff-filter=U)" ] || git rev-parse -q --verify MERGE_HEAD >/dev/null; then
            log "agent could not finish the merge; $BRANCH left at ${before:0:7}"
            notify "Upstream merge needs you: conflicts left. Log: $LOG"
            exit 1
        fi
    fi
fi

build()
{
    npm ci --silent && npx tsc --noEmit && npm test --silent \
        && npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
}

if ! build; then
    if [ "$upstream_new" = 1 ]; then
        log "build or tests failed after the merge; asking the agent"
        run_agent "After merging $UPSTREAM into the fork, the check 'npx tsc --noEmit && npm test && npx tauri build --bundles app' fails. Fix the fork so it passes, keeping both upstream's and the fork's behaviour, and commit the fix."
        if [ -n "$(git status --porcelain --untracked-files=no)" ] || ! build; then
            log "still failing; $BRANCH left at ${before:0:7}"
            notify "Upstream update failed to build; kept the current version. Log: $LOG"
            exit 1
        fi
    else
        log "build failed on $BRANCH itself (${before:0:7}); nothing staged"
        notify "Your fork does not build. Log: $LOG"
        exit 1
    fi
fi

new="$(git rev-parse HEAD)"
app="$(command ls -d "$CARGO_TARGET_DIR"/release/bundle/macos/*.app 2>/dev/null | head -1)"
if [ -z "$app" ]; then
    log "build said ok but no .app found"
    exit 1
fi

# Move `mine` forward only if it is still where this run started.
cd "$REPO" || exit 1
if [ "$new" != "$before" ]; then
    if [ "$(git branch --show-current)" = "$BRANCH" ]; then
        # The main checkout is on `mine`: fast-forward it; git refuses if that would touch local edits.
        if [ "$(git rev-parse HEAD)" != "$before" ] || ! git merge --quiet --ff-only "$new"; then
            log "$BRANCH moved or has conflicting local edits; update kept at ${new:0:7} in $WORK, nothing staged"
            notify "Upstream update built, but your checkout changed meanwhile. It retries next open."
            exit 1
        fi
    elif ! git update-ref "refs/heads/$BRANCH" "$new" "$before"; then
        log "$BRANCH moved during the run; nothing staged"
        exit 1
    fi
fi

rm -rf "$STAGED.tmp"
if ! { ditto "$app" "$STAGED.tmp" && rm -rf "$STAGED" && mv "$STAGED.tmp" "$STAGED"; }; then
    log "could not stage the app (disk full?)"
    rm -rf "$STAGED.tmp"
    exit 1
fi
echo "$new" >"$BUILT_SHA"
git push --quiet origin "$BRANCH" || log "push to origin failed (kept locally)"
log "staged ${new:0:7}; loads on next open"
if [ "$upstream_new" = 1 ]; then
    notify "Upstream update ready. It loads next time you open MonoCode."
fi
