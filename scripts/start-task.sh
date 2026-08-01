#!/usr/bin/env bash
set -euo pipefail

owner="${1:-}"
task="${2:-}"

if [[ ! "$owner" =~ ^[a-z0-9][a-z0-9-]*$ ]] ||
   [[ ! "$task" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Usage: $0 <owner> <short-kebab-case-task>" >&2
  echo "Example: $0 cayden lead-scraper-fix" >&2
  exit 2
fi

branch="${owner}/${task}"
protected_deploy_branch="claude/prospect-reply-automation-q2jei"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Worktree is not clean. Commit/stash your work before starting a task." >&2
  exit 1
fi

git fetch origin main

if git show-ref --verify --quiet refs/heads/main; then
  git switch main
else
  git switch --track -c main origin/main
fi

git pull --ff-only origin main

if [[ "$branch" == "main" || "$branch" == "$protected_deploy_branch" ]]; then
  echo "Refusing to create a protected branch." >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$branch" ||
   git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "Branch already exists: $branch" >&2
  exit 1
fi

git switch -c "$branch"

cat <<EOF
Created $branch from current origin/main.

Post in Slack:
  Working on $task. Branch: $branch.

Then push:
  git push -u origin $branch
EOF
