#!/usr/bin/env bash
#
# Move one or more Jira issues to a sprint, using the public Jira Agile REST API
# (not acli, which has no sprint-assignment command).
#
# Per-repo values (site, board) come from `.agents/skills.config` — the shared
# skills config — so this script is not tied to any one project. Resolution
# order for each value: environment variable > .agents/skills.config > built-in
# default. Credentials are NEVER read from that file (it is committed): the
# account email comes from $JIRA_EMAIL and the token from the OS keychain.
#
# Setup (one-time, run yourself — never paste the token into a chat/agent):
#   macOS (zsh, the default shell): `security add-generic-password -w` alone truncates
#   long tokens (~128 chars) because its hidden prompt uses the old getpass() buffer —
#   Atlassian API tokens run ~192 chars, so that form silently corrupts them. Use a
#   shell-side hidden read instead, then pass the value through as the -w argument:
#     read -s "JIRA_TOKEN?Paste Jira API token: "; echo
#     security add-generic-password -a "$JIRA_EMAIL" -s "jira-api-token" -U -w "$JIRA_TOKEN"
#     unset JIRA_TOKEN
#   (bash uses `read -s -p "prompt" JIRA_TOKEN` instead — zsh's -p means "read from a
#   coprocess", not "show a prompt", so the bash form fails with "read: -p: no coprocess")
#   Linux:  secret-tool store --label="Jira API Token" service jira-api-token account "$JIRA_EMAIL"
#           (prompts for the token on stdin — no known length limit there)
#
# Create a token at: https://id.atlassian.com/manage-profile/security/api-tokens
#
# Usage:
#   jira-sprint.sh ACME-123 [ACME-124 ...]           # move to the board's current active sprint
#   jira-sprint.sh --sprint 42 ACME-123             # move to a specific sprint ID
#   jira-sprint.sh --backlog ACME-123               # move back to the backlog (out of any sprint)
#
# Env vars (each overrides the config file):
#   JIRA_EMAIL     (required — no default; set in your shell profile, e.g. export JIRA_EMAIL="you@company.com")
#   JIRA_SITE      (config: jira_site; default: bluetel.atlassian.net)
#   JIRA_BOARD_ID  (config: jira_board_id; no default — required for sprint moves)

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

JIRA_SITE="${JIRA_SITE:-$(cfg_get jira_site)}"
JIRA_SITE="${JIRA_SITE:-bluetel.atlassian.net}"
JIRA_BOARD_ID="${JIRA_BOARD_ID:-$(cfg_get jira_board_id)}"

SPRINT_ID=""
BACKLOG=false
ISSUES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sprint)
      SPRINT_ID="$2"
      shift 2
      ;;
    --backlog)
      BACKLOG=true
      shift
      ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      ISSUES+=("$1")
      shift
      ;;
  esac
done

if [[ ${#ISSUES[@]} -eq 0 ]]; then
  echo "Error: no issue keys given. Usage: jira-sprint.sh [--sprint ID|--backlog] KEY [KEY ...]" >&2
  exit 1
fi

if [[ -z "${JIRA_EMAIL:-}" ]]; then
  echo "Error: JIRA_EMAIL is not set. Export it in your shell profile, e.g.:" >&2
  echo '  export JIRA_EMAIL="you@company.com"' >&2
  exit 1
fi

# A board is only needed to discover the active sprint; --sprint and --backlog don't use it.
if [[ "$BACKLOG" == false && -z "$SPRINT_ID" && -z "$JIRA_BOARD_ID" ]]; then
  echo "Error: no Jira board configured, so the active sprint cannot be found." >&2
  echo "Set it once for this repo:" >&2
  echo "  sh lib/skills.sh config set 'jira_board_id=<id>'   # or edit .agents/skills.config" >&2
  echo "…or pass a sprint explicitly with --sprint <id>, or export JIRA_BOARD_ID." >&2
  exit 1
fi

get_token() {
  if [[ "$(uname)" == "Darwin" ]]; then
    security find-generic-password -a "$JIRA_EMAIL" -s "jira-api-token" -w 2>/dev/null
  else
    secret-tool lookup service jira-api-token account "$JIRA_EMAIL" 2>/dev/null
  fi
}

TOKEN="$(get_token || true)"
if [[ -z "$TOKEN" ]]; then
  echo "Error: no API token found in the keychain for account '$JIRA_EMAIL'." >&2
  if [[ "$(uname)" == "Darwin" ]]; then
    echo "Store one with: security add-generic-password -a \"$JIRA_EMAIL\" -s \"jira-api-token\" -U -w" >&2
  else
    echo "Store one with: secret-tool store --label=\"Jira API Token\" service jira-api-token account \"$JIRA_EMAIL\"" >&2
  fi
  exit 1
fi

issues_json=$(printf '"%s",' "${ISSUES[@]}")
issues_json="[${issues_json%,}]"

api() {
  local method="$1" path="$2" body="${3:-}"
  curl -sS -f -u "${JIRA_EMAIL}:${TOKEN}" \
    -X "$method" \
    -H "Content-Type: application/json" \
    ${body:+-d "$body"} \
    "https://${JIRA_SITE}${path}"
}

if [[ "$BACKLOG" == true ]]; then
  api POST "/rest/agile/1.0/backlog/issue" "{\"issues\": ${issues_json}}" >/dev/null
  echo "Moved ${ISSUES[*]} to the backlog."
  exit 0
fi

if [[ -z "$SPRINT_ID" ]]; then
  SPRINT_ID=$(api GET "/rest/agile/1.0/board/${JIRA_BOARD_ID}/sprint?state=active" \
    | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
  if [[ -z "$SPRINT_ID" ]]; then
    echo "Error: no active sprint found on board $JIRA_BOARD_ID." >&2
    exit 1
  fi
fi

api POST "/rest/agile/1.0/sprint/${SPRINT_ID}/issue" "{\"issues\": ${issues_json}}" >/dev/null
echo "Moved ${ISSUES[*]} to sprint $SPRINT_ID."
