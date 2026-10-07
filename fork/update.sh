#!/bin/bash
# Background updater for the personal MonoCode fork.
# Started by the `monocode` launcher every time MonoCode opens. It:
#   1. merges new upstream commits into the `mine` branch (an agent fixes conflicts),
#   2. runs the tests and builds the app,
#   3. stages the new app; the launcher swaps it in on the next open.
# A failed run leaves `mine` and the staged app exactly as they were.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$HOME/.local/state/monocode-fork"
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

log()
{
    echo "[$(date '+%F %T')] $*"
}

notify()
{
    osascript -e "display notification \"$1\" with title \"MonoCode fork\"" >/dev/null 2>&1
}

# One run at a time. A lock older than 2 hours is from a crashed run.
if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
        rm -rf "$LOCK"
        mkdir "$LOCK" || exit 0
    else
        exit 0
    fi
fi
trap 'rm -rf "$LOCK"' EXIT

cd "$REPO" || exit 1
log "start"

if [ "$(git branch --show-current)" != "$BRANCH" ]; then
    log "skip: repo is on $(git branch --show-current), not $BRANCH"
    exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    log "skip: uncommitted changes in the repo (someone is working in it)"
    exit 0
fi

git fetch --quiet upstream || { log "skip: fetch failed (offline?)"; exit 0; }

before="$(git rev-parse HEAD)"
merged_upstream=0

run_agent()
{
    # $1 = task. The agent works in this repo only and must leave the tree committed or clean.
    claude -p "$1" \
        --model "$AGENT_MODEL" --effort low \
        --permission-mode acceptEdits \
        --allowedTools "Read" "Edit" "Write" "Grep" "Glob" \
            "Bash(git:*)" "Bash(npm:*)" "Bash(npx:*)" "Bash(cargo:*)" \
        --append-system-prompt "You are the unattended updater for a personal fork of MonoCode in $REPO. Keep the fork's own features working and take upstream's changes. Never push, never touch files outside the repo, never delete fork/. If you cannot finish safely, say FAILED and stop."
}

if ! git merge-base --is-ancestor "$UPSTREAM" HEAD; then
    log "merging $(git rev-list --count HEAD.."$UPSTREAM") upstream commits"
    if git merge --no-edit "$UPSTREAM"; then
        merged_upstream=1
    else
        log "conflicts: $(git diff --name-only --diff-filter=U | tr '\n' ' ')"
        run_agent "A git merge of $UPSTREAM into $BRANCH stopped with conflicts. Resolve every conflict so both upstream's change and the fork's change keep working, then run 'npx tsc --noEmit' and 'npm test', fix what you broke, and finish with 'git add -A && git commit --no-edit'."
        if [ -n "$(git diff --name-only --diff-filter=U)" ] || [ -f .git/MERGE_HEAD ]; then
            log "agent could not finish the merge; rolled back"
            git merge --abort 2>/dev/null
            git reset --hard --quiet "$before"
            notify "Upstream merge needs you: conflicts left. Log: $LOG"
            exit 1
        fi
        merged_upstream=1
    fi
fi

head="$(git rev-parse HEAD)"
if [ -f "$BUILT_SHA" ] && [ "$(cat "$BUILT_SHA")" = "$head" ]; then
    log "up to date ($head)"
    exit 0
fi

build()
{
    npm ci --silent && npx tsc --noEmit && npm test --silent && npx tauri build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
}

if ! build; then
    if [ "$merged_upstream" = 1 ]; then
        log "build or tests failed after the merge; asking the agent"
        run_agent "After merging $UPSTREAM into $BRANCH, the check 'npx tsc --noEmit && npm test && npx tauri build --bundles app' fails. Fix the fork so it passes, keeping both upstream's and the fork's behaviour, and commit the fix."
        if [ -n "$(git status --porcelain --untracked-files=no)" ] || ! build; then
            log "still failing; rolled back to $before"
            git reset --hard --quiet "$before"
            notify "Upstream update failed to build; kept the current version. Log: $LOG"
            exit 1
        fi
    else
        log "build failed on $BRANCH itself ($head); nothing staged"
        notify "Your fork does not build. Log: $LOG"
        exit 1
    fi
fi

app="$(command ls -d "$REPO"/target/release/bundle/macos/*.app 2>/dev/null | head -1)"
if [ -z "$app" ]; then
    log "build said ok but no .app found"
    exit 1
fi

rm -rf "$STAGED.tmp"
ditto "$app" "$STAGED.tmp" && rm -rf "$STAGED" && mv "$STAGED.tmp" "$STAGED"
git rev-parse HEAD >"$BUILT_SHA"
git push --quiet origin "$BRANCH" || log "push to origin failed (kept locally)"
log "staged $(git rev-parse --short HEAD); loads on next open"
if [ "$merged_upstream" = 1 ]; then
    notify "Upstream update ready. It loads next time you open MonoCode."
fi
