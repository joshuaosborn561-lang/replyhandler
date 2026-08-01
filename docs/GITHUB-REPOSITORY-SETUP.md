# One-time GitHub setup for two-person development

The repository files provide CODEOWNERS, CI, branch naming, and workflow
documentation. GitHub branch protection must still be enabled by a repository
administrator; a committed file cannot turn it on.

At the time this document was added, the API reported no repository rulesets,
and the automation token could not administer branch protection (`403 Resource
not accessible by integration`).

## Protect `main`

In **GitHub → Settings → Rules → Rulesets**, create a branch ruleset targeting
`main`:

1. **Require a pull request before merging**
2. Require **1 approving review**
3. **Require review from Code Owners**
4. **Dismiss stale approvals** when new commits are pushed
5. Require approval of the **most recent reviewable push**
6. Require status checks:
   - `CI / Invariant guards`
   - `CI / Branch policy`
7. **Require branches to be up to date before merging**
8. Block force pushes
9. Block branch deletion
10. Do not allow bypasses for collaborators; only Josh may bypass for an
    emergency

This is what prevents Cayden from merging over Josh's confirmed decisions:
`CODEOWNERS` requests Josh on every PR, and the ruleset makes that review
mandatory.

## Protect the Railway deployment branch

Railway currently deploys:

```text
claude/prospect-reply-automation-q2jei
```

Create the same ruleset for that branch. Do not push or merge into it directly.

Recommended cleanup:

1. In Railway service settings, change the source branch to `main`.
2. Merge a no-op/documentation PR and verify `/health` reports that commit.
3. Remove the special deployment branch from Railway.
4. Archive/delete it after confirming production.

After that, `main` is the only integration/deployment branch and no manual
two-branch synchronization is needed.

## Collaborator permissions

- Josh: repository admin/maintainer.
- Cayden: write access so he can push feature branches and open PRs.
- Cayden should not receive ruleset bypass permission.
- Keep Actions permissions read-only unless a workflow explicitly needs more.

## Daily workflow

```bash
./scripts/start-task.sh cayden short-task-name
# edit, commit, push
git push -u origin cayden/short-task-name
# open PR; Josh reviews; CI passes; merge
```

Post this in Slack before editing shared files:

```text
Working on <task>. Owning <files/subsystem>. Branch: cayden/<task>.
```

## Emergency production fix

Even urgent changes use a branch and PR:

```bash
./scripts/start-task.sh josh hotfix-description
```

Keep the PR minimal, run the guards, merge, then add any follow-up cleanup as a
separate task. Do not disable the ruleset or force-push production branches.
