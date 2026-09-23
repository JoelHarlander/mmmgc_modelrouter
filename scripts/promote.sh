#!/usr/bin/env bash
# Promote dev to main: the release path, run from a normal clone of this repository.
#
# It does every local step of docs/RELEASING.md and stops before the one that is visible to users:
# nothing here pushes or publishes. The last thing it prints is the exact push commands, so the
# maintainer reviews `git log` and the tag before anyone's `pi update` can see them.
#
#   scripts/promote.sh 0.2.0            # release 0.2.0, then open 0.3.0-dev on dev
#   scripts/promote.sh 0.2.0 0.2.1-dev  # same, choosing the next dev version explicitly
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage: scripts/promote.sh <version> [next-dev-version]

  <version>           the release, X.Y.Z (see docs/RELEASING.md for what makes it patch/minor/major)
  [next-dev-version]  what dev carries afterwards; defaults to the next minor as X.Y+1.0-dev
EOF
	exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
VERSION="$1"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: <version> must be X.Y.Z with no prerelease suffix (got '$VERSION')" >&2; exit 2; }
if [ $# -eq 2 ]; then
	NEXT_DEV="$2"
else
	NEXT_DEV="$(printf '%s' "$VERSION" | awk -F. '{printf "%d.%d.0-dev", $1, $2 + 1}')"
fi
[[ "$NEXT_DEV" == *-dev ]] || { echo "error: [next-dev-version] must end in -dev (got '$NEXT_DEV')" >&2; exit 2; }

cd "$(dirname "$0")/.."
step() { printf '\n== %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

step "checking the clone is in a state a release may be cut from"
[ -z "$(git status --porcelain)" ] || die "working tree is not clean; commit or set aside your changes first"
START_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --prune origin main dev
for branch in main dev; do
	git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null || die "no local $branch branch; create it with: git branch $branch origin/$branch"
	[ "$(git rev-parse "$branch")" = "$(git rev-parse "origin/$branch")" ] || die "$branch is not level with origin/$branch; reconcile it before promoting"
done
if git rev-parse --verify --quiet "refs/tags/v$VERSION" >/dev/null; then die "tag v$VERSION already exists"; fi
git merge-base --is-ancestor main dev || die "main is not an ancestor of dev; merge main into dev first so the promotion is a fast-forward"
[ "$(git rev-parse main)" != "$(git rev-parse dev)" ] || die "dev holds nothing main does not; there is no release to cut"

step "running the release gate on dev"
# This is where a CI workflow would gate instead (see docs/RELEASING.md): the same four commands,
# run against the dev commit being promoted. Until one exists, they run here.
git checkout --quiet dev
npm run check
npm test
npm run smoke
npm run smoke:billing

step "stamping $VERSION on dev and promoting it to main"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
git commit --quiet -am "release: v$VERSION"
git checkout --quiet main
git merge --ff-only dev
git tag -a "v$VERSION" -m "pi-modelrouter v$VERSION"

step "opening the next dev cycle"
git checkout --quiet dev
npm version "$NEXT_DEV" --no-git-tag-version --allow-same-version >/dev/null
git commit --quiet -am "start $NEXT_DEV"
[ "$START_BRANCH" = "dev" ] || git checkout --quiet "$START_BRANCH"

cat <<EOF

Local promotion done. Nothing has been pushed. Review it:

  git log --oneline --decorate -n 5 main
  git show v$VERSION --stat

Then publish the release, stable channel first:

  git push origin main "v$VERSION"
  git push origin dev

main now carries v$VERSION; dev carries $NEXT_DEV.
EOF
