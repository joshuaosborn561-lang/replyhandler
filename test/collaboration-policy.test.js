const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('repo collaboration requires feature branches and Josh review', () => {
  const owners = read('.github/CODEOWNERS');
  const workflow = read('.github/workflows/ci.yml');
  const contributing = read('CONTRIBUTING.md');
  const decisions = read('DECISIONS.md');

  assert.match(owners, /^\* @joshuaosborn561-lang/m);
  assert.match(workflow, /name: Branch policy/);
  assert.match(workflow, /Branch must be <owner>\/<short-kebab-case-task>/);
  assert.match(workflow, /npm ci --omit=dev/);
  assert.match(contributing, /git pull --ff-only origin main/);
  assert.match(contributing, /Never commit directly to `main`/);
  assert.match(decisions, /All work lands through a task branch and Josh-reviewed PR/);
});

test('task helper refuses dirty or existing branches', () => {
  const helper = read('scripts/start-task.sh');
  assert.match(helper, /git status --porcelain/);
  assert.match(helper, /git fetch origin main/);
  assert.match(helper, /git pull --ff-only origin main/);
  assert.match(helper, /Branch already exists/);
});

test('pull request template protects decisions and requires ownership', () => {
  const template = read('.github/pull_request_template.md');
  assert.match(template, /Files\/subsystem announced in Slack/);
  assert.match(template, /This does not reverse anything in `DECISIONS\.md`/);
  assert.match(template, /Josh explicitly approved/);
});
