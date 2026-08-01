# Working together

This repository is maintained by Josh and Cayden. Production has been broken
before by work landing on stale or competing branches, so the workflow below is
required even for small changes.

## One task, one owner, one branch

Before starting, post a short ownership note:

> Working on `<feature/fix>` in `<files/subsystem>`. Branch: `<name>/<task>`.

If someone already owns the same shared file or subsystem, coordinate before
editing it. High-conflict areas include:

- `src/routes/webhooks.js`
- `src/services/classifier.js`
- `src/services/smartlead-poller.js`
- `src/services/slack.js`
- `src/cron.js`
- `schema.sql` and `migrations/`
- `.env.example`
- `DECISIONS.md`, `CLAUDE.md`, and `test/owner-intent.test.js`

## Start every task from current main

Use the helper:

```bash
./scripts/start-task.sh cayden lead-scraper-fix
# or
./scripts/start-task.sh josh booking-check-fix
```

Equivalent manual commands:

```bash
git status                         # must be clean
git switch main
git pull --ff-only origin main
git switch -c cayden/lead-scraper-fix
```

Branch names must use:

```text
<owner>/<short-kebab-case-task>
```

Examples: `cayden/lead-scraper-fix`, `josh/booking-context`,
`cursor/admin-auth`.

Never commit directly to `main` or
`claude/prospect-reply-automation-q2jei`.

## While working

- Keep the branch focused on one task.
- Commit and push small, coherent changes often.
- Pulling another branch into yours is not a substitute for starting fresh.
- If the task expands into a second subsystem, open a second branch/PR.
- Do not force-push a branch another person is reviewing or using.
- Never delete or weaken guard tests just to get CI green.

## Before opening a PR

```bash
git fetch origin
git rebase origin/main
npm ci
npm test
git diff --check origin/main...HEAD
```

Resolve conflicts on your feature branch, then push it. Whoever merges second
owns conflict resolution and should talk through non-trivial conflicts with the
owner of the first PR.

## Pull requests

Every change lands through a PR, including a change you plan to review
yourself.

- Keep the PR small and describe exactly what behavior changes.
- Name the files/subsystem you own in the PR.
- Include tests and rollout/migration steps.
- Wait for CI.
- Josh reviews changes to product behavior and all CODEOWNERS paths.
- A PR that changes a settled decision needs Josh's explicit approval and a new
  append-only entry in `DECISIONS.md`.

## Product decisions are protected

`DECISIONS.md` is append-only. `test/owner-intent.test.js` encodes Josh's
settled choices. If a guard blocks a change, do not edit the test to make it
pass. Discuss the reversal with Josh first, then:

1. append a new decision explaining what supersedes the old one;
2. update the implementation;
3. update/add the guard;
4. call out the reversal in the PR.

## Deployment branches

The current Railway service deploys
`claude/prospect-reply-automation-q2jei`. Until Railway is changed to deploy
`main`, both branches must have the same protection rules and deployment-branch
updates must happen through PRs.

The recommended end state is to configure Railway to deploy `main`, verify one
deployment, then retire the special deployment branch. See
`docs/GITHUB-REPOSITORY-SETUP.md`.
