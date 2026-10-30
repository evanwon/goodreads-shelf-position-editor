#!/usr/bin/env bash
# What's in flight, for the start of a Claude Code session (.claude/settings.json's SessionStart hook, whose stdout the
# session reads). Auto-memory is off for this repo, so this is where a new session learns where things stand: open issues
# in progress on a project board, the ones waiting on Evan, the most recently active ones, and this checkout's git state.
# GitHub and git are the source, so nothing drifts. One GraphQL query; every lookup has a time limit and fails quietly,
# and it always exits 0, so a slow or offline start still starts.
# Usage: .claude/hooks/session-brief.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WAITING='^(needs-owner|needs-evan|waiting-on-evan)$'   # labels that mean "waits on Evan"
t() { timeout "${BRIEF_TIMEOUT:-10}" "$@" 2>/dev/null; }

nwo=$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
owner=${nwo%%/*}; name=${nwo#*/}

# Open issues by the owner or collaborators (the session reads their titles), most recently updated first, as
# "board status<TAB>labels<TAB>#n title"; @tsv escapes any tab or newline in a title.
rows=""
[ -n "$nwo" ] && rows=$(t gh api graphql -F o="$owner" -F n="$name" -f query='query($o: String!, $n: String!) {
  repository(owner: $o, name: $n) { issues(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title authorAssociation labels(first: 10) { nodes { name } }
      projectItems(first: 5) { nodes { fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name } } } } } } } }' \
  --jq '.data.repository.issues.nodes[] | select(.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR"))
    | [([.projectItems.nodes[].fieldValueByName.name // empty][0] // ""), ([.labels.nodes[].name] | join(",")),
       ("#\(.number) \(.title)" | .[0:110])] | @tsv')

if [ -z "$nwo" ]; then
  echo "In flight: this checkout has no GitHub origin."
elif [ -z "$rows" ]; then
  echo "In flight: GitHub didn't answer, or $nwo has no open issues."
else
  doing=$(awk -F'\t' 'tolower($1) ~ /^(doing|in progress)$/ { print "  " $3 }' <<<"$rows")
  if [ -n "$doing" ]; then echo "In progress on the board ($nwo):"; echo "$doing"
  else echo "Most recently active open issues ($nwo; no board item is in progress):"
    awk -F'\t' 'NR <= 5 { print "  " $3 }' <<<"$rows"; fi
  waiting=$(awk -F'\t' -v re="$WAITING" '{ n = split($2, l, ","); for (i = 1; i <= n; i++) if (l[i] ~ re) { print "  " $3; break } }' <<<"$rows")
  [ -z "$waiting" ] || { echo "Waiting on Evan:"; echo "$waiting"; }
fi

branch=$(git -C "$ROOT" branch --show-current 2>/dev/null)
ahead=$(git -C "$ROOT" rev-list --count '@{u}..HEAD' 2>/dev/null || echo "?")
dirty=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
echo "Git: ${branch:-detached HEAD}, $ahead commit(s) not pushed, $dirty changed file(s)"
git -C "$ROOT" worktree list 2>/dev/null | tail -n +2 | grep -v '/prepush/' | sed 's/^/  worktree: /'
exit 0
