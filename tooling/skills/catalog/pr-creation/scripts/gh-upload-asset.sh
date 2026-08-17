#!/usr/bin/env bash
#
# Upload files as GitHub user-attachment assets and print their URLs — the same
# thing drag-and-drop does in the web UI, but from a terminal, so screenshots and
# screen recordings can be embedded in a PR body or comment without a human
# dragging them into a browser.
#
# THE ENDPOINT IS UNDOCUMENTED. `uploads.github.com/user-attachments/assets`
# accepts a bearer token today; GitHub can change or withdraw that at any time.
# Always check the exit status instead of assuming a URL came back, and fall back
# to asking the user to drag the file in if this stops working.
#
# Auth: the token comes from `gh auth token`, i.e. a *user* token. An
# Actions-issued GITHUB_TOKEN is an installation token and is not known to work
# here — verify it before building CI on this.
#
# Usage:
#   gh-upload-asset.sh after.png                      # one file
#   gh-upload-asset.sh before.png after.png demo.mp4  # several, in order
#   gh-upload-asset.sh --repo owner/name shot.png     # explicit repo
#
# Output: one URL per input file on stdout, in the order given. Everything else
# goes to stderr, so `URL=$(gh-upload-asset.sh shot.png)` is safe.
#
# Embedding the result:
#   image:  ![alt text](URL)
#   video:  the bare URL on its own line — wrapping it in ![]() stops GitHub
#           rendering a player.
#
# Size: GitHub caps attachments (~10MB for images, ~100MB for video). A large
# upload fails at the endpoint; shrink the file rather than retrying.

set -euo pipefail

# cfg_get <key> — read a key from the nearest .agents/skills.config, walking up
# from $PWD. Prints nothing when the file or key is absent.
cfg_get() {
  local key="$1" dir="$PWD" file=""
  while :; do
    if [[ -f "$dir/.agents/skills.config" ]]; then
      file="$dir/.agents/skills.config"
      break
    fi
    [[ "$dir" == "/" || -z "$dir" ]] && break
    dir=$(dirname "$dir")
  done
  [[ -n "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | head -1
}

REPO=""
FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      FILES+=("$1")
      shift
      ;;
  esac
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "Error: no files given. Usage: gh-upload-asset.sh [--repo owner/name] FILE [FILE ...]" >&2
  exit 1
fi

for dep in gh curl; do
  command -v "$dep" >/dev/null 2>&1 || {
    echo "Error: '$dep' is required but not installed." >&2
    exit 1
  }
done

# Repo resolution: --repo > the checkout's own remote > .agents/skills.config.
if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)
fi
if [[ -z "$REPO" ]]; then
  owner=$(cfg_get repo_owner)
  name=$(cfg_get repo_name)
  [[ -n "$owner" && -n "$name" ]] && REPO="$owner/$name"
fi
if [[ -z "$REPO" ]]; then
  echo "Error: could not determine the repository. Pass --repo owner/name." >&2
  exit 1
fi

TOKEN=$(gh auth token 2>/dev/null || true)
if [[ -z "$TOKEN" ]]; then
  echo "Error: no GitHub token. Run 'gh auth login' first." >&2
  exit 1
fi

# The endpoint keys off the numeric repository id, not owner/name.
REPO_ID=$(gh api "repos/$REPO" --jq .id)
if [[ -z "$REPO_ID" ]]; then
  echo "Error: could not read the repository id for '$REPO'." >&2
  exit 1
fi

# Attachments are typed by content_type, not by extension — a wrong type renders
# as a download link instead of an inline image or player.
mime_for() {
  case "${1##*.}" in
    png)          printf 'image/png' ;;
    jpg|jpeg)     printf 'image/jpeg' ;;
    gif)          printf 'image/gif' ;;
    webp)         printf 'image/webp' ;;
    svg)          printf 'image/svg+xml' ;;
    mp4)          printf 'video/mp4' ;;
    mov)          printf 'video/quicktime' ;;
    webm)         printf 'video/webm' ;;
    pdf)          printf 'application/pdf' ;;
    zip)          printf 'application/zip' ;;
    txt|log)      printf 'text/plain' ;;
    json)         printf 'application/json' ;;
    *)            printf 'application/octet-stream' ;;
  esac
}

# Percent-encode the display name for the query string. ASCII filenames only;
# a multibyte name is encoded byte-wise by the shell and may display oddly.
urlencode() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c=${s:i:1}
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *)               out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

for file in "${FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Error: no such file: $file" >&2
    exit 1
  fi

  base=$(basename "$file")
  mime=$(mime_for "$base")
  name=$(urlencode "$base")

  echo "Uploading $base ($mime) to $REPO…" >&2

  response=$(curl -sS -f -X POST \
    "https://uploads.github.com/user-attachments/assets?name=${name}&content_type=${mime}&repository_id=${REPO_ID}" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/json" \
    --data-binary "@$file") || {
    echo "Error: upload failed for $base. The endpoint is undocumented and may have changed;" >&2
    echo "       ask the user to drag the file into the PR in the browser instead." >&2
    exit 1
  }

  # The response carries the asset URL as "url"; older write-ups of this endpoint
  # say "href", so accept either. `|| true` keeps a non-match from tripping
  # `set -e` before the empty-url message below can explain what happened.
  url=$(printf '%s' "$response" \
    | grep -o '"\(url\|href\)"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed 's/.*"\([^"]*\)"$/\1/' || true)

  if [[ -z "$url" ]]; then
    echo "Error: upload of $base returned no asset URL. Raw response:" >&2
    printf '%s\n' "$response" >&2
    exit 1
  fi

  printf '%s\n' "$url"
done
