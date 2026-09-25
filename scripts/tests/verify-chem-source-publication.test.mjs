import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CHEM_ROOT, IGNORED_CANDIDATES, REQUIRED_PATHS, verifyChemSourcePublication } from '../verify-chem-source-publication.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const snapshotPath = `${CHEM_ROOT}/snapshot-manifest.json`;
const developmentPath = `${CHEM_ROOT}/development-manifest.json`;
const sha256 = data => createHash('sha256').update(data).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'chem-publication-test-'));
  t.after(() => {
    // The only recursive removal is this exact fresh fixture directory.
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(root.startsWith(join(resolve(tmpdir()), 'chem-publication-test-')));
    rmSync(root, { recursive: true, force: true });
  });
  git(root, 'init', '--quiet');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'config', 'core.excludesFile', '');
  write(root, '.gitignore', readFileSync(join(repository, '.gitignore')));
  const snapshot = JSON.parse(readFileSync(join(repository, snapshotPath), 'utf8'));
  for (const path of REQUIRED_PATHS) write(root, path, 'fixture\n');
  write(root, snapshotPath, JSON.stringify(snapshot));
  for (const path of Object.keys(snapshot.files)) {
    const relative = `${CHEM_ROOT}/${path}`;
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    copyFileSync(join(repository, relative), join(root, relative));
  }
  const development = { version: 'chem-development-snapshot/v1', sourceManifestHash: snapshot.sourceManifestHash, files: {} };
  for (const path of ['tests/test_publication_probe.py', 'desktop/main.cjs']) {
    const content = Buffer.from('development fixture\n');
    write(root, `${CHEM_ROOT}/${path}`, content);
    development.files[path] = { sha256: sha256(content), bytes: content.length };
  }
  write(root, developmentPath, JSON.stringify(development));
  git(root, 'add', '--all');
  return root;
}

const has = (result, code, path) => result.diagnostics.some(item => item.code === code && (!path || item.path === path));

test('published source with real immutable hashes and repository ignore policy passes', t => {
  const root = fixture(t);
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.equal(result.snapshotFiles, 254);
  assert.equal(result.developmentFiles, 2);
  const cli = spawnSync(process.execPath, [join(repository, 'scripts/verify-chem-source-publication.mjs'), '--repo', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ok, true);
});

test('a tracked source hidden by a broad ignore still fails through --no-index', t => {
  const root = fixture(t);
  appendFileSync(join(root, '.gitignore'), `\n/${CHEM_ROOT}/\n`);
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  assert.ok(has(result, 'SOURCE_IGNORED', `${CHEM_ROOT}/pyproject.toml`));
  assert.ok(has(result, 'SOURCE_IGNORED', `${CHEM_ROOT}/tests/test_publication_probe.py`));
});

test('missing nested runtime and timer exclusions fail candidate checks', t => {
  const root = fixture(t);
  appendFileSync(join(root, '.gitignore'), '\n!.chem-backends/\n!timer.dat\n');
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  assert.ok(has(result, 'PRIVATE_CANDIDATE_NOT_IGNORED', `${CHEM_ROOT}/nested/.chem-backends/runtime.txt`));
  assert.ok(has(result, 'PRIVATE_CANDIDATE_NOT_IGNORED', `${CHEM_ROOT}/nested/timer.dat`));
});

test('all tracked operator source and both skill copies remain visible to Git', t => {
  const root = fixture(t);
  const extra = 'src/proto_agent/publication_probe.py';
  write(root, extra, 'operator fixture\n');
  git(root, 'add', '--', extra);
  const skill = 'apps/proto-workbench/runtime/workspace-template/.codex/skills/research-provenance/SKILL.md';
  appendFileSync(join(root, '.gitignore'), `\n/${extra}\n/${skill}\n`);
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  assert.ok(has(result, 'SOURCE_IGNORED', extra));
  assert.ok(has(result, 'SOURCE_IGNORED', skill));
});

test('force-tracked local artifacts fail even when ignore policy remains correct', t => {
  const root = fixture(t);
  for (const path of IGNORED_CANDIDATES) write(root, path, 'must not publish\n');
  git(root, 'add', '--force', '--', ...IGNORED_CANDIDATES);
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  for (const path of IGNORED_CANDIDATES) assert.ok(has(result, 'FORBIDDEN_TRACKED_FILE', path), path);
  assert.equal(has(result, 'PRIVATE_CANDIDATE_NOT_IGNORED'), false);
});

test('an untracked integration source and development test fail publication', t => {
  const root = fixture(t);
  const paths = [`${CHEM_ROOT}/tests/test_publication_probe.py`, 'apps/proto-workbench/src/renderer/ChemWorkspace.tsx'];
  git(root, 'rm', '--cached', '--', ...paths);
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  for (const path of paths) assert.ok(has(result, 'REQUIRED_NOT_TRACKED', path));
});

test('modified immutable and development files fail their recorded hashes', t => {
  const root = fixture(t);
  const paths = [`${CHEM_ROOT}/LICENSE`, `${CHEM_ROOT}/tests/test_publication_probe.py`];
  for (const path of paths) appendFileSync(join(root, path), 'changed\n');
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  for (const path of paths) assert.ok(has(result, 'FILE_HASH_MISMATCH', path));
});

test('modified manifest map fails JSON.stringify binding', t => {
  const root = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, snapshotPath), 'utf8'));
  manifest.files.LICENSE.bytes += 1;
  write(root, snapshotPath, JSON.stringify(manifest));
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  assert.ok(has(result, 'SNAPSHOT_MANIFEST_HASH_MISMATCH', snapshotPath));
});

test('removing an immutable manifest entry fails even with a recomputed binding', t => {
  const root = fixture(t);
  const manifest = JSON.parse(readFileSync(join(root, snapshotPath), 'utf8'));
  delete manifest.files.LICENSE;
  manifest.sourceManifestHash = sha256(JSON.stringify(manifest.files));
  write(root, snapshotPath, JSON.stringify(manifest));
  const result = verifyChemSourcePublication(root);
  assert.equal(result.ok, false);
  assert.ok(has(result, 'SNAPSHOT_COUNT_MISMATCH'));
  assert.ok(has(result, 'DEVELOPMENT_BINDING_MISMATCH'));
});
