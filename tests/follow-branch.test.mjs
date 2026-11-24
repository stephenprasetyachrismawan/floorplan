// watch.mjs --follow: a worktree kept for the map moves to the branch's new commits, and a worktree with local edits
// to tracked files is left where it is.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL } from './helpers.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'floorplan-follow-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

const origin = path.join(tmp, 'origin.git');
const dev = path.join(tmp, 'dev');
const repo = path.join(tmp, 'repo');
const map = path.join(tmp, 'map-preprod');
execFileSync('git', ['init', '--quiet', '--bare', '-b', 'preprod', origin]);
execFileSync('git', ['clone', '--quiet', origin, dev], { stdio: 'ignore' });
const commit = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(dev, file)), { recursive: true });
  fs.writeFileSync(path.join(dev, file), text);
  git(dev, 'add', '-A');
  execFileSync('git', ['-C', dev, ...ident, 'commit', '--quiet', '-m', file]);
  git(dev, 'push', '--quiet', 'origin', 'HEAD:preprod');
  return git(dev, 'rev-parse', 'HEAD');
};
commit('src/a.js', 'export const a = 1;\n');
execFileSync('git', ['clone', '--quiet', origin, repo], { stdio: 'ignore' });
git(repo, 'worktree', 'add', '--quiet', '--detach', map, 'origin/preprod');

const watchOnce = () => execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'watch.mjs'), map, '--once', '--no-graphify', '--follow', 'origin/preprod'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('the map worktree moves to the commit the branch moved to', () => {
  const next = commit('src/b.js', "import { a } from './a.js';\nexport const b = a + 1;\n");
  const out = watchOnce();
  assert.equal(git(map, 'rev-parse', 'HEAD'), next);
  assert.match(out, /origin\/preprod is at/);
  assert.ok(fs.existsSync(path.join(map, 'src', 'b.js')));
  assert.ok(fs.existsSync(path.join(map, 'floorplan', '.cache', 'scan.json')), 'the map was scanned');
});

test('a worktree with local edits to tracked files is not moved', () => {
  const here = git(map, 'rev-parse', 'HEAD');
  commit('src/c.js', 'export const c = 3;\n');
  fs.appendFileSync(path.join(map, 'src', 'a.js'), '// edited\n');
  const out = watchOnce();
  assert.equal(git(map, 'rev-parse', 'HEAD'), here);
  assert.match(out, /has local edits/);
});
