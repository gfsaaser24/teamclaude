import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MARKER,
  toPosixPath,
  cmdShim,
  ps1Shim,
  shShim,
  prependToPathList,
  removeFromPathList,
  findRealClaude,
} from '../src/shim.js';

const INVOKE = {
  cmd: 'teamclaude run -- %*',
  ps1: "& teamclaude run '--' @args",
  sh: 'exec teamclaude run -- "$@"',
};
const REAL = 'C:\\Users\\x\\.local\\bin\\claude.exe';

test('toPosixPath converts drive-letter paths for Git Bash', () => {
  assert.equal(toPosixPath('C:\\Users\\x\\claude.exe'), '/c/Users/x/claude.exe');
  assert.equal(toPosixPath('D:/tools/claude.exe'), '/d/tools/claude.exe');
});

test('every shim flavor carries the marker, the guard, and both exec paths', () => {
  for (const [content, guard, forward] of [
    [cmdShim('claude', REAL, INVOKE), '%TEAMCLAUDE_RUN_GUARD%', '%*'],
    [ps1Shim('claude', REAL, INVOKE), '$env:TEAMCLAUDE_RUN_GUARD', '@args'],
    [shShim('claude', REAL, INVOKE), '$TEAMCLAUDE_RUN_GUARD', '"$@"'],
  ]) {
    assert.ok(content.includes(MARKER), 'marker present');
    assert.ok(content.includes(guard), 'guard checked');
    assert.ok(content.includes('teamclaude run'), 'routes through run');
    assert.ok(content.includes(forward), 'forwards args');
  }
  // Direct path is baked in; the sh flavor uses the posix form.
  assert.ok(cmdShim('claude', REAL, INVOKE).includes(`"${REAL}" %*`));
  assert.ok(shShim('claude', REAL, INVOKE).includes(toPosixPath(REAL)));
});

test('presetEnv entries are set without overriding existing values', () => {
  const env = [{ name: 'HAPPY_CLAUDE_PATH', value: REAL }];
  const happyReal = 'C:\\Users\\x\\AppData\\Roaming\\npm\\happy.cmd';
  assert.ok(cmdShim('happy', happyReal, INVOKE, env)
    .includes(`if not defined HAPPY_CLAUDE_PATH set "HAPPY_CLAUDE_PATH=${REAL}"`));
  assert.ok(ps1Shim('happy', happyReal, INVOKE, env)
    .includes(`if (-not $env:HAPPY_CLAUDE_PATH) { $env:HAPPY_CLAUDE_PATH = '${REAL}' }`));
  assert.ok(shShim('happy', happyReal, INVOKE, env)
    .includes(`[ -n "$HAPPY_CLAUDE_PATH" ] || { HAPPY_CLAUDE_PATH="${REAL}"; export HAPPY_CLAUDE_PATH; }`));
  // Without presetEnv nothing is injected.
  assert.ok(!cmdShim('claude', REAL, INVOKE).includes('defined'));
});

test('prependToPathList prepends once, case-insensitively', () => {
  const dir = 'C:\\Users\\x\\.teamclaude\\bin';
  const base = 'C:\\a;C:\\b';
  assert.equal(prependToPathList(base, dir), `${dir};C:\\a;C:\\b`);
  // Already present (different case) → unchanged.
  const withDir = `c:\\users\\x\\.TEAMCLAUDE\\bin;${base}`;
  assert.equal(prependToPathList(withDir, dir), withDir);
  assert.equal(prependToPathList('', dir), dir);
});

test('removeFromPathList strips the dir case-insensitively and drops empties', () => {
  const dir = 'C:\\Users\\x\\.teamclaude\\bin';
  assert.equal(removeFromPathList(`C:\\a;c:\\users\\x\\.TEAMCLAUDE\\bin;C:\\b`, dir), 'C:\\a;C:\\b');
  assert.equal(removeFromPathList('C:\\a;;C:\\b', dir), 'C:\\a;C:\\b');
});

test('findRealClaude skips the shim dir and marker files, prefers .exe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tc-shim-'));
  try {
    const shimD = join(root, 'shim');
    const markerD = join(root, 'marker');
    const realD = join(root, 'real');
    await mkdir(shimD); await mkdir(markerD); await mkdir(realD);
    // A claude in the shim dir and a marker-carrying claude.cmd elsewhere must
    // both be skipped in favor of the real one further down the PATH.
    await writeFile(join(shimD, 'claude.exe'), 'anything');
    await writeFile(join(markerD, 'claude.cmd'), `@echo off\r\nrem ${MARKER}\r\n`);
    await writeFile(join(realD, 'claude.exe'), 'real');
    const pathStr = [shimD, markerD, realD].join(';');
    assert.equal(findRealClaude(pathStr, shimD), join(realD, 'claude.exe'));
    // Nothing but shims → null.
    assert.equal(findRealClaude([shimD, markerD].join(';'), shimD), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
