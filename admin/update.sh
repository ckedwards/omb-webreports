#!/usr/bin/env bash
# Update omb-webreports: bring this clone up to date with git, then run
# admin/install.sh from it (so the new installer installs the new code).
#
#   sudo admin/update.sh                    fast-forward the current branch
#   sudo admin/update.sh --ref v1.2.0       a tag, branch or commit
#   sudo admin/update.sh --from-unsafe-dev  development: no git at all; install this
#                                           checkout as it is (logged as unsafe)
#
# Other options are passed to install.sh. The clone must be root-owned with no
# local changes; development checkouts need --from-unsafe-dev.
set -euo pipefail

SRC=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)
# shellcheck source=_lib.sh
source "$SRC/admin/_lib.sh"

REF="" UNSAFE=0 PASS=()
while (( $# )); do
  case $1 in
    --ref) REF=${2:?--ref needs a tag, branch or commit}; shift ;;
    --from-unsafe-dev) UNSAFE=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed -e '/^set -euo/d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) PASS+=("$1") ;;
  esac
  shift
done
(( EUID == 0 )) || die "run as root: sudo $0"

if (( UNSAFE )); then
  [[ -z $REF ]] || die "--ref and --from-unsafe-dev don't mix: a development checkout is installed as it is"
  warn "UNSAFE: development install from $SRC; the git pull was skipped (this checkout is installed as it is)."
  logger -t omb-webreports "UNSAFE update from development checkout $SRC: git pull skipped" 2>/dev/null || true
  exec bash "$SRC/admin/install.sh" --from-unsafe-dev "${PASS[@]}"
fi

check_source "$SRC" 0
[[ -d $SRC/.git ]] || die "$SRC is not a git clone"
git() { command git -C "$SRC" "$@"; }
[[ -z $(git status --porcelain) ]] || die "$SRC has local changes; a production clone must match the repository (git -C $SRC status)"

before=$(git rev-parse HEAD)
git fetch --quiet --tags --prune origin
if [[ -n $REF ]]; then
  if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    git checkout --quiet "$REF" 2>/dev/null || git checkout --quiet -b "$REF" "origin/$REF"
    git merge --quiet --ff-only "origin/$REF"
  else
    git checkout --quiet --detach "$REF"
  fi
else
  git symbolic-ref -q HEAD >/dev/null || die "$SRC is on a fixed tag or commit; pick what to move to with --ref <branch|tag>"
  git merge --quiet --ff-only '@{upstream}'
fi
after=$(git rev-parse HEAD)
if [[ $before == "$after" ]]; then echo "already up to date at ${after:0:12} ($(git describe --tags --always))"
else echo "updated ${before:0:12} → ${after:0:12} ($(git describe --tags --always))"; git log --oneline "$before..$after" | head -20; fi

exec bash "$SRC/admin/install.sh" "${PASS[@]}"
