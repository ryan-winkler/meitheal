#!/usr/bin/env bash
set -euo pipefail

signature='I have read the CLA Document and I hereby sign the CLA.'
exempt='["ryan-winkler","dependabot[bot]","renovate[bot]","github-actions[bot]","copilot[bot]"]'
ledger_branch=cla-signatures
ledger_endpoint="repos/$GITHUB_REPOSITORY/contents/signatures/version1/cla.json"
prompt_marker='<!-- meitheal-cla -->'
event="$GITHUB_EVENT_PATH"
commenter=

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

case "$GITHUB_EVENT_NAME" in
  pull_request_target)
    number=$(jq -er '.pull_request.number | select(type == "number" and . > 0)' "$event")
    ;;
  issue_comment)
    if ! jq -e --arg signature "$signature" '
      .action == "created" and .issue.pull_request != null and .comment.user.type == "User"
      and (.comment.body == $signature or .comment.body == "recheck")
    ' "$event" >/dev/null; then
      exit 0
    fi
    number=$(jq -er '.issue.number | select(type == "number" and . > 0)' "$event")
    commenter=$(jq -er '.comment.user.id | select(type == "number" and . > 0)' "$event")
    ;;
  *)
    exit 0
    ;;
esac

endpoint="repos/$GITHUB_REPOSITORY/pulls/$number"
pull=$(gh api "$endpoint")
if [[ $(jq -er '.state' <<< "$pull") != open ]]; then
  exit 0
fi
head=$(jq -er '.head.sha | select(type == "string" and test("^[a-f0-9]{40}$"))' <<< "$pull")
if [[ "$GITHUB_EVENT_NAME" == pull_request_target ]]; then
  event_head=$(jq -er '.pull_request.head.sha' "$event")
  [[ "$head" == "$event_head" ]] || fail "The pull request head changed. Check the workflow run for the latest commit."
fi

verify_head() {
  [[ $(gh api "$endpoint" --jq '.head.sha') == "$head" ]] ||
    fail "The pull request head changed. Check the workflow run for the latest commit."
}

record_status() {
  verify_head
  gh api --method POST "repos/$GITHUB_REPOSITORY/statuses/$head" \
    -f context='Contributor License Agreement' -f state="$1" -f description="$2" >/dev/null
}

# GitHub's pull request commit endpoint returns at most 250 commits.
count=$(jq -er '.commits | select(type == "number")' <<< "$pull")
if (( count < 1 || count > 250 )); then
  fail "The CLA check supports pull requests with 1 to 250 commits. Squash or split this contribution."
fi
opener=$(jq -er '.user.id | select(type == "number" and . > 0)' <<< "$pull")
commits=$(gh api --paginate --slurp "$endpoint/commits?per_page=100" | jq -c 'add')
if [[ -n "$commenter" ]] && ! jq -e --argjson commenter "$commenter" 'any(.[]; .author.id == $commenter)' <<< "$commits" >/dev/null; then
  exit 0
fi

if ! jq -e --arg sha "$head" --argjson count "$count" --argjson opener "$opener" '
  type == "array" and length == $count and any(.[]; .sha == $sha)
  and all(.[]; (.author.id | type == "number" and . > 0) and (.author.login | type == "string" and length > 0))
  and any(.[]; .author.id == $opener)
' <<< "$commits" >/dev/null; then
  record_status failure "Link every commit author to GitHub, including the PR opener."
  fail "Every commit needs a linked GitHub author, including a commit from the pull request opener."
fi

ledger_file=$(gh api "$ledger_endpoint?ref=$ledger_branch") ||
  fail "The CLA ledger is unavailable. See the release runbook for ledger setup."
ledger=$(jq -er '.content' <<< "$ledger_file" | base64 --decode)
jq -e '.signedContributors | type == "array"' <<< "$ledger" >/dev/null
required=$(jq -c --argjson exempt "$exempt" '
  [.[].author | select(.login as $login | $exempt | index($login) == null) | .id] | unique
' <<< "$commits")

if [[ -n "$commenter" ]] && jq -e --arg signature "$signature" '.comment.body == $signature' "$event" >/dev/null &&
  jq -e --argjson signer "$commenter" 'index($signer) != null' <<< "$required" >/dev/null &&
  ! jq -e --argjson signer "$commenter" 'any(.signedContributors[]; .id == $signer)' <<< "$ledger" >/dev/null; then
  verify_head
  ledger=$(jq -c --slurpfile events "$event" '
    $events[0] as $e | .signedContributors += [{
      id: $e.comment.user.id,
      name: $e.comment.user.login,
      comment_id: $e.comment.id,
      created_at: $e.comment.created_at,
      repoId: $e.repository.id,
      pullRequestNo: $e.issue.number
    }]
  ' <<< "$ledger")
  jq -Rs --arg branch "$ledger_branch" --arg sha "$(jq -er '.sha' <<< "$ledger_file")" '
    {branch: $branch, sha: $sha, content: @base64, message: "Record a contributor CLA signature"}
  ' <<< "$ledger" | gh api --method PUT "$ledger_endpoint" --input - >/dev/null
fi

if jq -e --argjson required "$required" '
  ($required - [.signedContributors[].id]) | length == 0
' <<< "$ledger" >/dev/null; then
  record_status success 'All contributors have signed the CLA.'
  exit 0
fi

record_status failure 'Read the CLA and sign in a pull request comment.'
comments="repos/$GITHUB_REPOSITORY/issues/$number/comments"
existing_prompt=$(gh api --paginate "$comments?per_page=100" --jq \
  '.[] | select(.user.id == 41898282 and (.body | startswith("<!-- meitheal-cla -->"))) | .id')
if [[ -z "$existing_prompt" ]]; then
  document="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/blob/$GITHUB_WORKFLOW_SHA/.github/CLA.md"
  body=$(printf '%s\n\nPlease read the [Contributor License Agreement](%s) and reply on this pull request with the exact text below.\n\n> %s\n' \
    "$prompt_marker" "$document" "$signature")
  gh api --method POST "$comments" -f body="$body" >/dev/null
fi
