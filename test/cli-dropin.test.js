// `teamclaude` as a drop-in for `claude`.
//
// Editors and launchers let you point them at a "claude binary", probe it with
// `--version`, then invoke it with claude's own flags. Answering `--version`
// with THIS package's version made one such tool refuse to run — it read 1.2.0
// as Claude Code's version and demanded >= 2.1.111. The old default branch was
// worse: any unrecognised flag started a second proxy instead of launching
// claude.
//
// These tests pin the dispatch, not the versions: the numbers move, the routing
// must not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src', 'index.js');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function run(args) {
  try {
    return { out: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30_000 }).trim(), code: 0 };
  } catch (err) {
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim(), code: err.status ?? 1 };
  }
}

test('`version` reports THIS package, so the real version stays reachable', () => {
  const { out, code } = run(['version']);
  assert.equal(code, 0);
  assert.equal(out, pkgVersion);
});

test('`--version` does NOT report this package — that is the bug being fixed', () => {
  const { out } = run(['--version']);
  // Either claude answered (drop-in worked) or claude is absent and it errored.
  // What must never happen is us claiming to be the thing being version-checked.
  assert.notEqual(out, pkgVersion, '--version leaked the teamclaude version again');
});

test('`-V` behaves like `--version`, not like `version`', () => {
  const { out } = run(['-V']);
  assert.notEqual(out, pkgVersion);
});

test('an unknown NON-flag command still errors rather than silently launching', () => {
  const { out, code } = run(['definitely-not-a-command']);
  assert.equal(code, 1);
  assert.match(out, /Unknown command/);
});

test('claude-style flags are not mistaken for server flags', () => {
  // The regression: `--dangerously-skip-permissions` used to fall through to
  // serverCommand() and start a SECOND proxy. It must reach the run path
  // instead. Proxy-up or not, the one thing it must never print is the server
  // banner, so assert on that rather than on claude's behaviour.
  const { out } = run(['--dangerously-skip-permissions', '--version']);
  assert.doesNotMatch(out, /Starting on account|Port \d+ is already in use/,
    'a claude flag started the proxy instead of passing through');
});
