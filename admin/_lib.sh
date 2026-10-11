# Shared by admin/install.sh, admin/update.sh and admin/openmausbot-upgrade.sh.
# shellcheck shell=bash

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# Everything these scripts run, they run as root. So the code they run must be
# writable only by root: otherwise whoever can write it (you, and your bots,
# which run as you) can make root run anything. check_source SRC UNSAFE checks
# that SRC, everything in it and every directory above it are owned by root
# and not writable by group (other than root's) or others. With UNSAFE=1 (a
# development checkout, --from-unsafe-dev) it only warns, loudly, and logs it.
check_source() {
  local src=$1 unsafe=$2 d bad="" why=""
  d=$src
  while :; do
    local uid gid perm
    read -r uid gid perm < <(stat -c '%u %g %a' "$d")
    if [[ $uid != 0 ]]; then bad=$d why="owned by $(stat -c %U "$d")"; break; fi
    if (( 8#$perm & 8#020 )) && [[ $gid != 0 ]]; then bad=$d why="writable by group $(stat -c %G "$d")"; break; fi
    if (( 8#$perm & 8#002 )) && ! (( 8#$perm & 8#1000 )); then bad=$d why="writable by everyone"; break; fi
    [[ $d == / ]] && break
    d=$(dirname "$d")
  done
  if [[ -z $bad ]]; then
    bad=$(find "$src" \( ! -uid 0 -o \( ! -type l -perm /002 \) -o \( ! -type l ! -gid 0 -perm /020 \) \) -print -quit 2>/dev/null || true)
    [[ -n $bad ]] && why="not root-only ($(stat -c '%U:%G %A' "$bad"))"
  fi
  [[ -z $bad ]] && return 0
  if (( unsafe )); then
    warn "UNSAFE: installing from $src, which is not root-only ($bad: $why)."
    warn "UNSAFE: anyone who can write it, including bots running as its owner, can make root run their code."
    warn "UNSAFE: for development only. Production installs come from a root-owned clone (docs/setup.md)."
    logger -t omb-webreports "UNSAFE install from development checkout $src ($bad: $why)" 2>/dev/null || true
    return 0
  fi
  die "$src can't be installed from: $bad is $why.
  Root runs this code, so it must be writable only by root. Install from a root-owned clone:
    sudo git clone https://github.com/ckedwards/omb-webreports /usr/local/src/omb-webreports
  (For development only: --from-unsafe-dev.)"
}

# Read KEY=value lines without executing anything (never `source` a file a
# non-root user can write). Prints KEY=value, quotes stripped.
read_env_file() {
  local line
  [[ -f $1 ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)[[:space:]]*=[[:space:]]*(.*[^[:space:]])?[[:space:]]*$ ]]; then
      local k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]:-}
      [[ $v =~ ^\"(.*)\"$ || $v =~ ^\'(.*)\'$ ]] && v=${BASH_REMATCH[1]}
      printf '%s=%s\n' "$k" "$v"
    fi
  done < "$1"
}
