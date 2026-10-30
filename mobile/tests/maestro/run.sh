#!/bin/sh
# Runs the flows on a leased device, the same set on both platforms.
#
#   PAIR_LINK='monocode://pair?...' PROJECT=monocode SESSION='Some session' BRANCH=mine \
#     mobile/tests/maestro/run.sh ios|android [device id]
#
# Without PAIR_LINK it only runs the first-launch flow. Screenshots land in
# mobile/tests/maestro/out/<platform>/, which git ignores.
set -eu

platform=${1:?usage: run.sh ios\|android [device id]}
device=${2:-}
case "$platform" in
ios) app=com.clupai.monocode ;;
android) app=com.hardbeat920.monocodemobile ;;
*)
    echo "Unknown platform: $platform" >&2
    exit 2
    ;;
esac

here=$(cd "$(dirname "$0")" && pwd)
out="$here/out/$platform"
mkdir -p "$out"

run_flow() {
    maestro ${device:+--device "$device"} test \
        -e APP_ID="$app" \
        -e OUT="$out" \
        -e PAIR_LINK="${PAIR_LINK:-}" \
        -e PROJECT="${PROJECT:-}" \
        -e SESSION="${SESSION:-}" \
        -e BRANCH="${BRANCH:-}" \
        "$here/$1"
}

run_flow 01-connect.yaml
if [ -z "${PAIR_LINK:-}" ]; then
    echo "No PAIR_LINK: stopped after the first-launch flow."
    exit 0
fi
: "${PROJECT:?set PROJECT to a project name on the paired computer}"
: "${SESSION:?set SESSION to a session title in that project}"
: "${BRANCH:?set BRANCH to that project's current branch}"
run_flow 02-pair.yaml
run_flow 03-settings.yaml
run_flow 04-session.yaml
run_flow 05-workspace.yaml
echo "Screenshots: $out"
