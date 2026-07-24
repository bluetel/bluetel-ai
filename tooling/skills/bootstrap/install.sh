#!/bin/sh
# install.sh — the single publishable bootstrap for the AI skill installer.
#
#   curl -fsSL <raw-url>/tooling/skills/bootstrap/install.sh | sh
#
# It verifies prerequisites, performs a shallow + sparse `git clone` of ONLY the
# tooling/skills/ subtree of the source repo (no history, no unrelated monorepo
# content) into a temp dir, then launches the Claude CLI on the install skill.
#
# Target dependencies: claude, git >= 2.27, curl, a POSIX shell, and
# sha256sum or shasum. NO Node, jq, or tar required.

set -eu

REPO_URL="${SKILLS_REPO_URL:-https://github.com/harrytwigg/universal-react-monorepo.git}"
REPO_REF="${SKILLS_REPO_REF:-main}"
SUBTREE="tooling/skills"

err() { printf '%s\n' "$*" >&2; }

need() {
  # need <cmd> <install-guidance>
  if ! command -v "$1" >/dev/null 2>&1; then
    err "error: required tool '$1' not found."
    err "  $2"
    MISSING=1
  fi
}

MISSING=0
need claude "Install the Claude CLI: https://docs.claude.com/claude-code"
need git "Install git >= 2.27 (partial clone + sparse-checkout): https://git-scm.com/downloads"
need curl "Install curl (used to fetch this bootstrap)."
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  err "error: no sha256 tool found (need 'sha256sum' or 'shasum')."
  MISSING=1
fi

# git >= 2.27 for --filter=blob:none + sparse-checkout.
if command -v git >/dev/null 2>&1; then
  GIT_VER=$(git --version | awk '{print $3}')
  if [ -n "$GIT_VER" ]; then
    GIT_MAJOR=$(printf '%s' "$GIT_VER" | cut -d. -f1)
    GIT_MINOR=$(printf '%s' "$GIT_VER" | cut -d. -f2)
    if [ "$GIT_MAJOR" -lt 2 ] || { [ "$GIT_MAJOR" -eq 2 ] && [ "$GIT_MINOR" -lt 27 ]; }; then
      err "error: git $GIT_VER is too old; need >= 2.27 for sparse partial clone."
      MISSING=1
    fi
  fi
fi

if [ "$MISSING" -ne 0 ]; then
  err ""
  err "Install the missing tools above and re-run. Nothing was changed."
  exit 1
fi

TARGET="$PWD"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/skills-bootstrap.XXXXXX")
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

printf 'Fetching skills catalog (shallow, sparse) from %s@%s …\n' "$REPO_URL" "$REPO_REF"
git clone --depth 1 --filter=blob:none --sparse --branch "$REPO_REF" "$REPO_URL" "$TMP/repo" >/dev/null 2>&1 || {
  err "error: git clone failed. Check the ref '$REPO_REF' and your network. Nothing was changed."
  exit 1
}
git -C "$TMP/repo" sparse-checkout set "$SUBTREE" >/dev/null 2>&1 || {
  err "error: sparse-checkout of $SUBTREE failed. Nothing was changed."
  exit 1
}

SNAPSHOT="$TMP/repo/$SUBTREE"
if [ ! -f "$SNAPSHOT/skill/SKILL.md" ]; then
  err "error: snapshot missing $SUBTREE/skill/SKILL.md — repo layout changed?"
  exit 1
fi

# Record origin so installed records / merge-base reconstruction can find it.
export SKILLS_SOURCE_REPO="$REPO_URL"
export SKILLS_SOURCE_REF="$REPO_REF"
export SKILLS_SNAPSHOT="$SNAPSHOT"
export SKILLS_TARGET="$TARGET"

printf 'Launching Claude to install skills into %s …\n' "$TARGET"
exec claude "$SNAPSHOT/skill/SKILL.md"
