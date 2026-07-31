#!/bin/sh
# skills.sh — deterministic core for the AI skill installer.
#
# Usage: sh lib/skills.sh <command> [name...] [--force] [--on-conflict <mode>]
#                         [--target <dir>] [--catalog <dir>] [--all]
#
# Commands: list | status | install | update | help
#
# POSIX sh only (no bashisms). Human/line-based output — no JSON, no jq.
# The script never touches the network; the bootstrap owns downloading.
#
# Exit codes (stable contract):
#   0  success (including "nothing to do")
#   1  usage error (bad args/flags)
#   2  catalog invalid or unreadable
#   3  conflict needing a decision, no resolution mode given
#   4  target write failure (rolled back)
#   5  required tool missing (no sha256sum/shasum)
#   6  resolve produced conflict markers (record not advanced)

set -eu

# ---------------------------------------------------------------------------
# Globals & argument parsing
# ---------------------------------------------------------------------------

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

COMMAND=""
TARGET="$PWD"
CATALOG="$SCRIPT_DIR/../catalog"
ON_CONFLICT=""
ALL=0
NAMES=""

usage() {
  cat <<'EOF'
skills.sh — install and update shared AI skills

Usage:
  sh skills.sh list   [--catalog <dir>] [--target <dir>]
  sh skills.sh status [--catalog <dir>] [--target <dir>]
  sh skills.sh install <name...> [--force] [--on-conflict <mode>] [--catalog <dir>] [--target <dir>]
  sh skills.sh update  <name...>|--all [--force] [--on-conflict <mode>] [--catalog <dir>] [--target <dir>]
  sh skills.sh config  show | get <key> | set <key=value>… [--target <dir>]

Options:
  --force              alias for --on-conflict overwrite
  --on-conflict <mode> keep | overwrite | resolve (how to treat a locally-modified skill)
  --all                (update) target every installed outdated skill
  --target <dir>       target project root (default: $PWD)
  --catalog <dir>      catalog dir (default: the snapshot's catalog/)

Exit codes: 0 ok  1 usage  2 catalog  3 conflict  4 write  5 tool-missing  6 merge-conflict
EOF
}

die_usage() {
  printf '%s\n' "error: $1" >&2
  usage >&2
  exit 1
}

parse_args() {
  [ $# -gt 0 ] || die_usage "no command given"
  COMMAND="$1"
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) ON_CONFLICT="overwrite" ;;
      --all) ALL=1 ;;
      --on-conflict)
        shift
        [ $# -gt 0 ] || die_usage "--on-conflict needs a mode"
        case "$1" in
          keep | overwrite | resolve) ON_CONFLICT="$1" ;;
          *) die_usage "invalid --on-conflict mode: $1" ;;
        esac
        ;;
      --target)
        shift
        [ $# -gt 0 ] || die_usage "--target needs a dir"
        TARGET="$1"
        ;;
      --catalog)
        shift
        [ $# -gt 0 ] || die_usage "--catalog needs a dir"
        CATALOG="$1"
        ;;
      --*) die_usage "unknown flag: $1" ;;
      *) NAMES="${NAMES:+$NAMES }$1" ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Hash tooling (T007)
# ---------------------------------------------------------------------------

SHA_TOOL=""

_detect_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHA_TOOL="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA_TOOL="shasum"
  else
    printf '%s\n' "error: no sha256 tool found. Install 'sha256sum' (coreutils) or 'shasum' (Perl)." >&2
    exit 5
  fi
}

_sha256() {
  # reads stdin, prints the hex digest only
  if [ "$SHA_TOOL" = "sha256sum" ]; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}

# skill_hash <dir> — sha256 over content files (excludes skill.meta and .skill).
# Files sorted with LC_ALL=C for a stable, locale-independent order; each file
# contributes its relative path + a NUL separator + its raw bytes.
skill_hash() {
  (
    cd "$1" || exit 1
    find . -type f ! -name skill.meta ! -name .skill | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s\0' "$f"
      cat "$f"
    done | _sha256
  )
}

# ---------------------------------------------------------------------------
# skill.meta parsing + catalog scan (T008)
# ---------------------------------------------------------------------------

# meta_get <file> <key> — echo the value for KEY (first match), or empty.
meta_get() {
  _mg_file="$1"
  _mg_key="$2"
  _mg_val=""
  while IFS='=' read -r key val || [ -n "$key" ]; do
    case "$key" in
      '#'*) continue ;;
      '') continue ;;
    esac
    if [ "$key" = "$_mg_key" ]; then
      _mg_val="$val"
      break
    fi
  done <"$_mg_file"
  printf '%s' "$_mg_val"
}

is_kebab() {
  printf '%s' "$1" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$'
}

is_semver() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'
}

catalog_die() {
  printf '%s\n' "catalog error: $1" >&2
  exit 2
}

# catalog_names — echo every valid catalog skill name (one per line).
catalog_names() {
  [ -d "$CATALOG" ] || catalog_die "catalog dir not found: $CATALOG"
  for d in "$CATALOG"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [ -f "$d/skill.meta" ] || continue
    printf '%s\n' "$name"
  done
}

# validate_entry <name> — validate one catalog entry; catalog_die on problems.
validate_entry() {
  _ve_name="$1"
  _ve_dir="$CATALOG/$_ve_name"
  [ -d "$_ve_dir" ] || catalog_die "no such skill: $_ve_name"
  [ -f "$_ve_dir/skill.meta" ] || catalog_die "$_ve_name: missing skill.meta"
  [ -f "$_ve_dir/SKILL.md" ] || catalog_die "$_ve_name: missing SKILL.md"
  _ve_metaname=$(meta_get "$_ve_dir/skill.meta" name)
  _ve_version=$(meta_get "$_ve_dir/skill.meta" version)
  _ve_desc=$(meta_get "$_ve_dir/skill.meta" description)
  is_kebab "$_ve_metaname" || catalog_die "$_ve_name: name not kebab-case: '$_ve_metaname'"
  [ "$_ve_metaname" = "$_ve_name" ] || catalog_die "$_ve_name: skill.meta name '$_ve_metaname' != dir name"
  is_semver "$_ve_version" || catalog_die "$_ve_name: version not semver: '$_ve_version'"
  [ -n "$_ve_desc" ] || catalog_die "$_ve_name: missing description"
  # description is single-line by construction (meta_get reads one line per key).
  # requires must resolve
  _ve_req=$(meta_get "$_ve_dir/skill.meta" requires)
  for r in $_ve_req; do
    [ -d "$CATALOG/$r" ] && [ -f "$CATALOG/$r/skill.meta" ] || catalog_die "$_ve_name: requires missing skill '$r'"
  done
}

# ---------------------------------------------------------------------------
# semver compare (T009)
# ---------------------------------------------------------------------------

# semver_gt a b — success (0) if a > b, else 1. awk numeric compare (no sort -V).
semver_gt() {
  awk -v a="$1" -v b="$2" '
    BEGIN {
      na = split(a, aa, ".")
      nb = split(b, bb, ".")
      for (i = 1; i <= 3; i++) {
        x = (i <= na) ? aa[i] + 0 : 0
        y = (i <= nb) ? bb[i] + 0 : 0
        if (x > y) exit 0
        if (x < y) exit 1
      }
      exit 1
    }'
}

# ---------------------------------------------------------------------------
# Installed record I/O + SkillState derivation (T010)
# ---------------------------------------------------------------------------

record_path() { printf '%s' "$TARGET/.agents/skills/$1/.skill"; }
content_dir() { printf '%s' "$TARGET/.agents/skills/$1"; }
stub_path() { printf '%s' "$TARGET/.claude/skills/$1/SKILL.md"; }

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_record <name> <version> <hash> <source_ref>
write_record() {
  _wr_file=$(record_path "$1")
  {
    printf 'name=%s\n' "$1"
    printf 'version=%s\n' "$2"
    printf 'installed_hash=%s\n' "$3"
    printf 'source_repo=%s\n' "${SKILLS_SOURCE_REPO:-}"
    printf 'source_ref=%s\n' "$4"
    printf 'installed_at=%s\n' "$(now_utc)"
  } >"$_wr_file"
}

# skill_state <name> — echo the derived state.
skill_state() {
  _ss_name="$1"
  _ss_cdir=$(content_dir "$_ss_name")
  _ss_rec=$(record_path "$_ss_name")
  _ss_stub=$(stub_path "$_ss_name")

  _ss_has_content=0
  [ -d "$_ss_cdir" ] && [ -f "$_ss_cdir/SKILL.md" ] && _ss_has_content=1
  _ss_has_stub=0
  [ -f "$_ss_stub" ] && _ss_has_stub=1
  _ss_has_rec=0
  [ -f "$_ss_rec" ] && _ss_has_rec=1

  if [ "$_ss_has_content" -eq 0 ] && [ "$_ss_has_rec" -eq 0 ]; then
    printf 'not-installed'
    return
  fi

  # content present but no record, or content/stub disagree → inconsistent
  if [ "$_ss_has_rec" -eq 0 ]; then
    printf 'inconsistent'
    return
  fi
  if [ "$_ss_has_content" -eq 1 ] && [ "$_ss_has_stub" -eq 0 ]; then
    printf 'inconsistent'
    return
  fi
  if [ "$_ss_has_content" -eq 0 ]; then
    printf 'inconsistent'
    return
  fi

  _ss_rver=$(meta_get "$_ss_rec" version)
  _ss_rhash=$(meta_get "$_ss_rec" installed_hash)
  if [ -z "$_ss_rver" ] || [ -z "$_ss_rhash" ]; then
    printf 'unknown'
    return
  fi

  _ss_cur=$(skill_hash "$_ss_cdir")
  if [ "$_ss_cur" != "$_ss_rhash" ]; then
    printf 'locally-modified'
    return
  fi

  _ss_cver=$(meta_get "$CATALOG/$_ss_name/skill.meta" version)
  if [ -n "$_ss_cver" ] && semver_gt "$_ss_cver" "$_ss_rver"; then
    printf 'outdated'
    return
  fi
  printf 'up-to-date'
}

# ---------------------------------------------------------------------------
# Per-repo config (.agents/skills.config)
# ---------------------------------------------------------------------------
#
# A small key=value file holding this project's conventions (ticket prefix,
# branch pattern, target repo, …). It is DATA consumed by skills at runtime —
# NOT part of any skill's tracked content, so it is never hashed and never
# touched by `update`. Written through this helper so the format is consistent
# and the write is atomic. Values may contain spaces (e.g. commit_format), so
# `set` operands are handled outside the space-split NAMES accumulator.

CONFIG_KEYS="ticket_prefix branch_pattern commit_format staging_branch base_branch repo_owner repo_name jira_site jira_project_key jira_board_id jira_epic_key"

config_path() { printf '%s' "$TARGET/.agents/skills.config"; }

# config_default <key> — the built-in fallback (this catalog's own conventions).
# Keys with no sensible cross-repo default resolve to empty; the consuming skill
# is responsible for asking rather than guessing. Deliberately NO credential or
# per-user keys here (e.g. JIRA_EMAIL / API tokens stay in the env + keychain).
config_default() {
  case "$1" in
    ticket_prefix) printf 'BTAI' ;;
    branch_pattern) printf 'feature/{ticket}' ;;
    commit_format) printf '{ticket}: {description}' ;;
    staging_branch) printf 'staging' ;;
    base_branch) printf 'main' ;;
    repo_owner) printf 'bluetel' ;;
    repo_name) printf 'bluetel-ai' ;;
    jira_site) printf 'bluetel.atlassian.net' ;;
    # The Jira project key is nearly always the ticket prefix, so derive it
    # rather than making the user state the same string twice.
    jira_project_key) config_effective ticket_prefix ;;
    jira_board_id) printf '' ;;
    jira_epic_key) printf '' ;;
    *) return 1 ;;
  esac
}

config_is_key() {
  for _ck in $CONFIG_KEYS; do
    [ "$_ck" = "$1" ] && return 0
  done
  return 1
}

# config_effective <key> — file value if present & non-empty, else the default.
config_effective() {
  _ce_key="$1"
  _ce_file=$(config_path)
  _ce_val=""
  [ -f "$_ce_file" ] && _ce_val=$(meta_get "$_ce_file" "$_ce_key")
  if [ -n "$_ce_val" ]; then
    printf '%s' "$_ce_val"
  else
    config_default "$_ce_key"
  fi
}

fail_config() {
  printf '%s\n' "write error: $1" >&2
  exit 4
}

# config_show — one KEY<TAB>VALUE<TAB>SOURCE line per known key (SOURCE: set|default).
config_show() {
  _cs_file=$(config_path)
  for _ck in $CONFIG_KEYS; do
    _src=default
    if [ -f "$_cs_file" ] && [ -n "$(meta_get "$_cs_file" "$_ck")" ]; then
      _src=set
    fi
    printf '%s\t%s\t%s\n' "$_ck" "$(config_effective "$_ck")" "$_src"
  done
}

# config_set <newline-separated key=value operands> — validate then atomically
# rewrite the managed file with every known key (overrides win, else current
# effective value is preserved).
config_set() {
  _cset_ops="$1"
  # Validate every operand first — reject typos before touching the file.
  _IFS_SAVE=$IFS
  IFS='
'
  for _pair in $_cset_ops; do
    IFS=$_IFS_SAVE
    case "$_pair" in
      *=*) : ;;
      *) die_usage "config set expects key=value, got: $_pair" ;;
    esac
    _pk=${_pair%%=*}
    config_is_key "$_pk" || die_usage "unknown config key '$_pk' (known: $CONFIG_KEYS)"
    IFS='
'
  done
  IFS=$_IFS_SAVE

  _cset_file=$(config_path)
  _cset_tmp="$_cset_file.tmp.$$"
  mkdir -p "$(dirname "$_cset_file")" || fail_config "cannot create $(dirname "$_cset_file")"

  # Persist ONLY explicit decisions: keys overridden in this call, plus keys
  # already explicitly set in the file. Never materialize a default — writing
  # them out would freeze derived values (e.g. jira_project_key, which tracks
  # ticket_prefix) and silently stop them following their source.
  {
    printf '# Managed by skills-install (sh skills.sh config set …).\n'
    printf '# Per-repo conventions consumed by shared skills. Safe to hand-edit values.\n'
    printf '# Only explicitly-set keys are listed; anything absent uses the catalog default.\n'
    for _ck in $CONFIG_KEYS; do
      _val=""
      _found=0
      IFS='
'
      for _pair in $_cset_ops; do
        case "$_pair" in
          "$_ck="*)
            _val=${_pair#*=}
            _found=1
            ;;
        esac
      done
      IFS=$_IFS_SAVE
      if [ "$_found" -eq 0 ]; then
        # Not touched now — carry over only a pre-existing explicit value.
        [ -f "$_cset_file" ] && _val=$(meta_get "$_cset_file" "$_ck")
      fi
      # An empty value means "use the default" — omit the line entirely.
      # A plain `[ … ] && printf` would make the block exit non-zero whenever the
      # last key is empty, tripping the write-failure path; use an explicit if.
      if [ -n "$_val" ]; then
        printf '%s=%s\n' "$_ck" "$_val"
      fi
    done
  } >"$_cset_tmp" || { rm -f "$_cset_tmp"; fail_config "cannot write config"; }
  mv "$_cset_tmp" "$_cset_file" || { rm -f "$_cset_tmp"; fail_config "cannot move config into place"; }
  printf 'wrote %s\n' "$_cset_file"
}

# cmd_config <subcommand> [operands…] — its own arg handling (values may contain
# spaces), invoked from main() before parse_args.
cmd_config() {
  _sub="${1:-}"
  [ -n "$_sub" ] || die_usage "config needs a subcommand: show | get <key> | set <key=value>…"
  shift
  _cfg_ops=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --target)
        shift
        [ $# -gt 0 ] || die_usage "--target needs a dir"
        TARGET="$1"
        ;;
      --catalog)
        shift
        [ $# -gt 0 ] || die_usage "--catalog needs a dir"
        CATALOG="$1"
        ;;
      --*) die_usage "unknown flag: $1" ;;
      *) _cfg_ops="${_cfg_ops}$1
" ;;
    esac
    shift
  done

  case "$_sub" in
    path)
      config_path
      printf '\n'
      ;;
    show) config_show ;;
    get)
      _key=$(printf '%s' "$_cfg_ops" | head -n1)
      [ -n "$_key" ] || die_usage "config get needs a key"
      config_is_key "$_key" || die_usage "unknown config key '$_key' (known: $CONFIG_KEYS)"
      config_effective "$_key"
      printf '\n'
      ;;
    set)
      [ -n "$_cfg_ops" ] || die_usage "config set needs at least one key=value"
      config_set "$_cfg_ops"
      ;;
    *) die_usage "unknown config subcommand: $_sub" ;;
  esac
}

# ---------------------------------------------------------------------------
# Stub generation (T012)
# ---------------------------------------------------------------------------

yaml_escape() { printf '%s' "$1" | sed "s/'/''/g"; }

# generate_stub <name> <dest-file>
generate_stub() {
  _gs_name="$1"
  _gs_dest="$2"
  _gs_meta="$CATALOG/$_gs_name/skill.meta"
  _gs_desc=$(meta_get "$_gs_meta" description)
  _gs_hint=$(meta_get "$_gs_meta" argument_hint)
  {
    printf -- '---\n'
    printf 'name: %s\n' "$_gs_name"
    printf "description: '%s'\n" "$(yaml_escape "$_gs_desc")"
    if [ -n "$_gs_hint" ]; then
      printf "argument-hint: '%s'\n" "$(yaml_escape "$_gs_hint")"
    fi
    printf -- '---\n\n'
    printf '> **IMPORTANT:** You MUST read and follow the shared skill file at `.agents/skills/%s/SKILL.md` for the full procedure.\n' "$_gs_name"
  } >"$_gs_dest"
}

# ---------------------------------------------------------------------------
# Atomic staged-write engine (T011)
# ---------------------------------------------------------------------------

# Space-separated list of skill names written this invocation (for rollback).
WRITTEN_SKILLS=""
STAGING_DIRS=""

rollback() {
  for s in $STAGING_DIRS; do
    rm -rf "$s" 2>/dev/null || true
  done
  for s in $WRITTEN_SKILLS; do
    rm -rf "$(content_dir "$s")" 2>/dev/null || true
    rm -rf "$(dirname "$(stub_path "$s")")" 2>/dev/null || true
  done
}

fail_write() {
  printf '%s\n' "write error: $1" >&2
  rollback
  exit 4
}

# stage_and_commit <name> <version> <source_ref>
# Copies catalog content into a staging dir, then atomically moves content +
# stub into place and writes the record.
stage_and_commit() {
  _sc_name="$1"
  _sc_version="$2"
  _sc_ref="$3"
  _sc_src="$CATALOG/$_sc_name"
  _sc_stage="$TARGET/.agents/skills/.staging-$_sc_name"
  _sc_cdir=$(content_dir "$_sc_name")
  _sc_stubdir=$(dirname "$(stub_path "$_sc_name")")

  STAGING_DIRS="${STAGING_DIRS:+$STAGING_DIRS }$_sc_stage"

  mkdir -p "$TARGET/.agents/skills" "$TARGET/.claude/skills" || fail_write "cannot create skill roots"
  rm -rf "$_sc_stage" || fail_write "cannot clear staging"
  mkdir -p "$_sc_stage" || fail_write "cannot create staging"

  # Copy content files (everything except skill.meta) into staging.
  (cd "$_sc_src" && find . -type f ! -name skill.meta) | while IFS= read -r f; do
    _dst="$_sc_stage/$f"
    mkdir -p "$(dirname "$_dst")"
    cp "$_sc_src/$f" "$_dst"
  done || fail_write "$_sc_name: copy failed"

  # Compute the hash of the staged content (the bytes we are about to install).
  _sc_hash=$(skill_hash "$_sc_stage")

  # Commit: remove any prior content, move staged content into place.
  rm -rf "$_sc_cdir" || fail_write "$_sc_name: cannot clear old content"
  mv "$_sc_stage" "$_sc_cdir" || fail_write "$_sc_name: cannot move content into place"
  STAGING_DIRS=$(printf '%s' "$STAGING_DIRS" | sed "s#$_sc_stage##")
  WRITTEN_SKILLS="${WRITTEN_SKILLS:+$WRITTEN_SKILLS }$_sc_name"

  # Stub.
  mkdir -p "$_sc_stubdir" || fail_write "$_sc_name: cannot create stub dir"
  generate_stub "$_sc_name" "$_sc_stubdir/SKILL.md" || fail_write "$_sc_name: stub failed"

  # Record.
  write_record "$_sc_name" "$_sc_version" "$_sc_hash" "$_sc_ref" || fail_write "$_sc_name: record failed"

  # Test hook: fail after a named skill to exercise rollback.
  if [ -n "${SKILLS_FAIL_AFTER:-}" ] && [ "$SKILLS_FAIL_AFTER" = "$_sc_name" ]; then
    fail_write "SKILLS_FAIL_AFTER=$_sc_name (injected)"
  fi
}

# ---------------------------------------------------------------------------
# requires expansion
# ---------------------------------------------------------------------------

# expand_requires <name...> — echo the transitive closure (deduped, one/line).
expand_requires() {
  _er_seen=""
  _er_queue="$*"
  while [ -n "$_er_queue" ]; do
    _er_next=""
    for n in $_er_queue; do
      case " $_er_seen " in
        *" $n "*) continue ;;
      esac
      _er_seen="$_er_seen $n"
      _er_req=$(meta_get "$CATALOG/$n/skill.meta" requires)
      for r in $_er_req; do
        _er_next="$_er_next $r"
      done
    done
    _er_queue="$_er_next"
  done
  for n in $_er_seen; do printf '%s\n' "$n"; done
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_list() {
  for name in $(catalog_names); do
    validate_entry "$name"
    _cv=$(meta_get "$CATALOG/$name/skill.meta" version)
    _desc=$(meta_get "$CATALOG/$name/skill.meta" description)
    _state=$(skill_state "$name")
    _iv=""
    _rec=$(record_path "$name")
    [ -f "$_rec" ] && _iv=$(meta_get "$_rec" version)
    printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$_state" "$_cv" "$_iv" "$_desc"
  done
}

cmd_status() {
  for name in $(catalog_names); do
    validate_entry "$name"
    _state=$(skill_state "$name")
    case "$_state" in
      not-installed) continue ;;
    esac
    _cv=$(meta_get "$CATALOG/$name/skill.meta" version)
    _desc=$(meta_get "$CATALOG/$name/skill.meta" description)
    _iv=""
    _rec=$(record_path "$name")
    [ -f "$_rec" ] && _iv=$(meta_get "$_rec" version)
    printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$_state" "$_cv" "$_iv" "$_desc"
  done
}

emit_action() {
  # <name> <action> <version> [paths...]
  _ea_name="$1"
  _ea_action="$2"
  _ea_version="$3"
  shift 3
  printf '%s\t%s\t%s\n' "$_ea_name" "$_ea_action" "$_ea_version"
  for p in "$@"; do printf '    %s\n' "$p"; done
}

written_paths() {
  printf '%s %s %s' \
    "$(content_dir "$1")/SKILL.md" \
    "$(record_path "$1")" \
    "$(stub_path "$1")"
}

cmd_install() {
  [ -n "$NAMES" ] || die_usage "install needs at least one skill name"
  # Validate names exist first.
  for n in $NAMES; do
    [ -d "$CATALOG/$n" ] && [ -f "$CATALOG/$n/skill.meta" ] || catalog_die "no such skill: $n"
  done
  _targets=$(expand_requires $NAMES)
  for name in $_targets; do
    validate_entry "$name"
  done
  _added=""
  for t in $_targets; do
    case " $NAMES " in
      *" $t "*) ;;
      *) _added="$_added $t" ;;
    esac
  done
  [ -n "$_added" ] && printf '# also installing required:%s\n' "$_added"

  for name in $_targets; do
    _state=$(skill_state "$name")
    _cv=$(meta_get "$CATALOG/$name/skill.meta" version)
    case "$_state" in
      not-installed)
        stage_and_commit "$name" "$_cv" "${SKILLS_SOURCE_REF:-}"
        # shellcheck disable=SC2046
        emit_action "$name" install "$_cv" $(written_paths "$name")
        ;;
      up-to-date)
        emit_action "$name" skip "$_cv"
        ;;
      outdated)
        do_update_one "$name"
        ;;
      locally-modified | inconsistent | unknown)
        resolve_conflict "$name"
        ;;
    esac
  done
}

cmd_update() {
  if [ "$ALL" -eq 1 ]; then
    NAMES=""
    for name in $(catalog_names); do
      case "$(skill_state "$name")" in
        outdated) NAMES="${NAMES:+$NAMES }$name" ;;
      esac
    done
  fi
  [ -n "$NAMES" ] || die_usage "update needs skill names or --all"
  for n in $NAMES; do
    [ -d "$CATALOG/$n" ] && [ -f "$CATALOG/$n/skill.meta" ] || catalog_die "no such skill: $n"
    validate_entry "$n"
  done
  for name in $NAMES; do
    do_update_one "$name"
  done
}

# do_update_one <name> — apply the update/conflict policy to one skill.
do_update_one() {
  name="$1"
  _cv=$(meta_get "$CATALOG/$name/skill.meta" version)
  _state=$(skill_state "$name")
  case "$_state" in
    not-installed)
      stage_and_commit "$name" "$_cv" "${SKILLS_SOURCE_REF:-}"
      # shellcheck disable=SC2046
      emit_action "$name" install "$_cv" $(written_paths "$name")
      ;;
    up-to-date)
      emit_action "$name" skip "$_cv"
      ;;
    outdated)
      stage_and_commit "$name" "$_cv" "${SKILLS_SOURCE_REF:-}"
      # shellcheck disable=SC2046
      emit_action "$name" update "$_cv" $(written_paths "$name")
      ;;
    locally-modified | inconsistent | unknown)
      resolve_conflict "$name"
      ;;
  esac
}

# resolve_conflict <name> — apply ON_CONFLICT to a conflicted skill.
resolve_conflict() {
  name="$1"
  _cv=$(meta_get "$CATALOG/$name/skill.meta" version)
  case "$ON_CONFLICT" in
    "")
      emit_action "$name" conflict "$_cv"
      exit 3
      ;;
    keep)
      emit_action "$name" keep "$_cv"
      ;;
    overwrite)
      stage_and_commit "$name" "$_cv" "${SKILLS_SOURCE_REF:-}"
      # shellcheck disable=SC2046
      emit_action "$name" update "$_cv" $(written_paths "$name")
      ;;
    resolve)
      merge_resolve "$name"
      ;;
  esac
}

# merge_resolve <name> — three-way merge each content file (T026).
merge_resolve() {
  name="$1"
  _cv=$(meta_get "$CATALOG/$name/skill.meta" version)
  _rec=$(record_path "$name")
  _ref=$(meta_get "$_rec" source_ref)
  _cdir=$(content_dir "$name")
  _base=$(fetch_merge_base "$name" "$_ref" || true)

  if [ -z "$_base" ] || [ ! -d "$_base" ]; then
    # Base unobtainable → write .incoming sidecars, degrade to keep/overwrite.
    (cd "$CATALOG/$name" && find . -type f ! -name skill.meta) | while IFS= read -r f; do
      mkdir -p "$_cdir/$(dirname "$f")"
      cp "$CATALOG/$name/$f" "$_cdir/$f.incoming"
    done
    printf '# merge base unavailable for %s (source_ref=%s); wrote .incoming sidecars\n' "$name" "$_ref" >&2
    if [ "$ON_CONFLICT" = resolve ]; then
      emit_action "$name" keep "$_cv"
      return
    fi
    return
  fi

  _marker="${TMPDIR:-/tmp}/skills-merge-$name.$$.conflicts"
  rm -f "$_marker"
  (cd "$CATALOG/$name" && find . -type f ! -name skill.meta) | while IFS= read -r f; do
    _local="$_cdir/$f"
    _incoming="$CATALOG/$name/$f"
    _basef="$_base/$f"
    [ -f "$_basef" ] || _basef=/dev/null
    if [ -f "$_local" ]; then
      if ! git merge-file -p -L "local ($name)" -L "base" -L "incoming ($name)" \
        "$_local" "$_basef" "$_incoming" >"$_local.merged" 2>/dev/null; then
        printf 'CONFLICT\n' >>"$_marker"
      fi
      mv "$_local.merged" "$_local"
    else
      mkdir -p "$(dirname "$_local")"
      cp "$_incoming" "$_local"
    fi
  done

  _had_conflict=0
  [ -f "$_marker" ] && _had_conflict=1
  rm -f "$_marker"

  # Clean up an ephemeral (git-archive) base; never delete a caller-provided one.
  case "$_base" in
    "${SKILLS_BASE_DIR:-}"/*) : ;;
    *) rm -rf "$_base" ;;
  esac

  if [ "$_had_conflict" -eq 1 ]; then
    # Leave markers in place; do NOT advance the record.
    emit_action "$name" merge-conflict "$_cv"
    exit 6
  fi

  # Clean merge: regenerate stub + advance record to the new version.
  _newhash=$(skill_hash "$_cdir")
  generate_stub "$name" "$(stub_path "$name")"
  write_record "$name" "$_cv" "$_newhash" "${SKILLS_SOURCE_REF:-$_ref}"
  # shellcheck disable=SC2046
  emit_action "$name" merge "$_cv" $(written_paths "$name")
}

# fetch_merge_base <name> <ref> — reconstruct the originally-installed content.
# In-repo (source) usage: if the catalog is a git working tree, check out
# catalog/<name> at <ref>. Otherwise echo nothing (base unobtainable).
fetch_merge_base() {
  _fb_name="$1"
  _fb_ref="$2"
  # Test / offline hook: an explicit base snapshot dir (per-skill subdir).
  if [ -n "${SKILLS_BASE_DIR:-}" ] && [ -d "$SKILLS_BASE_DIR/$_fb_name" ]; then
    printf '%s' "$SKILLS_BASE_DIR/$_fb_name"
    return 0
  fi
  [ -n "$_fb_ref" ] || return 1
  _fb_tmp="${TMPDIR:-/tmp}/skills-base-$_fb_name.$$"
  rm -rf "$_fb_tmp"
  mkdir -p "$_fb_tmp"
  # Try to obtain the base from the catalog's own git history (source repo).
  if git -C "$CATALOG" rev-parse --git-dir >/dev/null 2>&1; then
    _fb_rel=$(cd "$CATALOG/$_fb_name" && git rev-parse --show-prefix 2>/dev/null || true)
    if [ -n "$_fb_rel" ] && git -C "$CATALOG" cat-file -e "$_fb_ref" 2>/dev/null; then
      if git -C "$CATALOG" archive "$_fb_ref" -- "$_fb_rel" 2>/dev/null | tar -x -C "$_fb_tmp" 2>/dev/null; then
        if [ -d "$_fb_tmp/$_fb_rel" ]; then
          printf '%s' "$_fb_tmp/$_fb_rel"
          return 0
        fi
      fi
    fi
  fi
  rm -rf "$_fb_tmp"
  return 1
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

main() {
  # config has its own arg handling (values may contain spaces) and needs no
  # sha tooling — route it before the generic parser.
  if [ "${1:-}" = config ]; then
    shift
    cmd_config "$@"
    exit 0
  fi
  parse_args "$@"
  case "$COMMAND" in
    help | -h | --help)
      usage
      exit 0
      ;;
  esac
  _detect_sha
  case "$COMMAND" in
    list) cmd_list ;;
    status) cmd_status ;;
    install) cmd_install ;;
    update) cmd_update ;;
    *) die_usage "unknown command: $COMMAND" ;;
  esac
}

main "$@"
