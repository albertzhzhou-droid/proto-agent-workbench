#!/usr/bin/env node
// Publication checks only: these do not establish backend or scientific acceptance.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CHEM_ROOT = 'apps/proto-workbench/runtime/chem-workbench';
const workbench = 'apps/proto-workbench';
const canonicalSkills = [
  'evidence-first-literature-review', 'governed-materials-review', 'lm-studio-model-endpoint',
  'proto-science-workflow', 'research-provenance', 'scientific-sequence-visualization',
  'sequence-resource-analysis',
];
export const REQUIRED_PATHS = [
  `${CHEM_ROOT}/snapshot-manifest.json`,
  `${CHEM_ROOT}/development-manifest.json`,
  ...[
    'chem_analysis.py', 'chem_coupled_reactions.py', 'chem_data.py',
    'chem_driven_reactions.py', 'chem_interfaces.py', 'chem_network_reactors.py',
    'chem_physical.py', 'chem_reactions.py', 'chem_science.py', 'launch.py',
    'model_binding.py', 'xdl-inspect.py',
  ].map(name => `${workbench}/runtime/chem-integration/${name}`),
  `${workbench}/runtime/modules/analysis.chemistry.json`,
  ...['fonts.css', 'paper-chem.css', 'paper-chem.js', 'xdl-panel.css', 'xdl-panel.js']
    .map(name => `${workbench}/src/chem-ui/${name}`),
  ...['chem-evidence.ts', 'chem-science.ts', 'chem-workbench.ts']
    .map(name => `${workbench}/src/main/services/${name}`),
  ...['chem-science-api.ts', 'chem-science.ts', 'chem-workbench.ts']
    .map(name => `${workbench}/src/shared/${name}`),
  ...[
    'ChemComputationWorkspace.tsx', 'ChemDataChart.tsx', 'ChemInterfaceResult.tsx',
    'ChemKineticsChart.tsx', 'ChemNavigation.tsx', 'ChemOperatorForm.tsx',
    'ChemReactionScene.tsx', 'ChemReactionStudyResult.tsx', 'ChemToolLibrary.tsx',
    'ChemWorkspace.tsx', 'chem-analysis-input.ts', 'chem-computation.css',
    'chem-interface-view.ts', 'chem-reaction-studies.ts', 'chem-reaction-view.ts',
    'chem-workspace.css',
  ].map(name => `${workbench}/src/renderer/${name}`),
  ...['sync-chem-workbench.mjs', 'verify-chem-workbench.mjs',
    'verify-chem-science-bridge.mjs', 'verify-chem-compute.mjs']
    .map(name => `${workbench}/scripts/${name}`),
  `${workbench}/licenses/Synthetic-Sciences-Chemistry-Skills-MIT.txt`,
  'src/proto_agent/compute.py', 'src/proto_agent/compute_chem.py',
  `${workbench}/src/shared/research-tool-registry.ts`,
  ...['harness-controller.ts', 'harness-context.ts', 'harness-iteration.ts',
    'harness-store.ts', 'harness-workspace.ts', 'execution-kernel.ts']
    .map(name => `${workbench}/src/main/services/${name}`),
  ...['.codex/skills', `${workbench}/runtime/workspace-template/.codex/skills`]
    .flatMap(root => canonicalSkills.flatMap(skill => ['SKILL.md', 'proto-skill.json']
      .map(name => `${root}/${skill}/${name}`))),
];

// Nonexistent candidates exercise Git's effective policy without creating artifacts.
export const IGNORED_CANDIDATES = [
  '.venv/runtime.txt', 'nested/.venv/runtime.txt', '.venv-test/runtime.txt',
  'venv/runtime.txt', '.chem-backends/runtime.txt', 'nested/.chem-backends/runtime.txt',
  '__pycache__/module.pyc', 'nested/__pycache__/module.pyc', 'module.pyc',
  '.pytest_cache/state', '.mypy_cache/state', '.ruff_cache/state', '.cache/state',
  '.uv-cache/state', 'nested/.cache/state', 'node_modules/package/index.js', 'scratch/output.json',
  'build/output.json', 'nested/build/output.json', 'dist/package.whl',
  'nested/dist/package.whl', 'timer.dat', 'nested/timer.dat',
  'secrets.env', 'nested/secrets.env', 'private.env', 'nested/custom.env', '.env', 'nested/.env.local',
  'weights/model.gguf', 'weights/model.safetensors', 'weights/model.onnx',
  'weights/model.pt', 'weights/model.pth',
].map(path => `${CHEM_ROOT}/${path}`);

export const SOURCE_CANDIDATES = [
  'src/chem_workbench/publication_probe.py', 'schemas/publication-probe.schema.json',
  'tests/test_publication_probe.py', 'tests/fixtures/publication-probe.json',
  'examples/publication-probe.chem', 'pyproject.toml', 'uv.lock', 'LICENSE',
  'desktop/main.cjs', 'desktop/preload.cjs',
].map(path => `${CHEM_ROOT}/${path}`);

const forbiddenDirectory = /^(?:\.venv(?:-.*)?|venv|\.chem-backends|__pycache__|build|dist|node_modules|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.uv-cache|\.npm-cache|\.pnpm-store|coverage|htmlcov)$/i;
const forbiddenFile = /^(?:timer\.dat|\.env(?:\..+)?|\.coverage(?:\..+)?)$|\.(?:env|py[co]|gguf|safetensors|onnx|pt|pth)$/i;
const chemScopes = [CHEM_ROOT, `${workbench}/runtime/chem-integration`, `${workbench}/src/chem-ui`];
const sourceScopes = [
  'src/', `${workbench}/src/`, `${workbench}/runtime/chem-integration/`,
  '.codex/skills/', `${workbench}/runtime/workspace-template/.codex/skills/`,
];
const hash = data => createHash('sha256').update(data).digest('hex');

export function isForbiddenChemPath(path) {
  const scope = chemScopes.find(root => path.startsWith(`${root}/`));
  if (!scope) return false;
  const pieces = path.slice(scope.length + 1).split('/');
  const name = pieces.pop();
  return (scope === CHEM_ROOT && pieces[0] === 'scratch') || pieces.some(piece => forbiddenDirectory.test(piece)) ||
    (name !== '.env.example' && forbiddenFile.test(name));
}

function validRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) &&
    !/[\\\x00-\x1f:]/.test(path) && !path.split('/').some(part => !part || part === '.' || part === '..');
}

export function verifyChemSourcePublication(repoRoot) {
  repoRoot = resolve(repoRoot);
  const diagnostics = [];
  const required = new Set(REQUIRED_PATHS);
  const counts = { snapshotFiles: 0, developmentFiles: 0, requiredPaths: 0, trackedPaths: 0 };
  const fail = (code, path, message) => diagnostics.push({ code, path, message });

  function git(args, input) {
    const result = spawnSync('git', args, { cwd: repoRoot, input, encoding: 'utf8', windowsHide: true });
    if (result.error || (result.status !== 0 && !(args[0] === 'check-ignore' && result.status === 1))) {
      throw new Error(result.error?.message || result.stderr.trim() || `git exited ${result.status}`);
    }
    return result.stdout.split('\0').filter(Boolean);
  }

  function readManifest(name, version) {
    const path = `${CHEM_ROOT}/${name}`;
    try {
      const manifest = JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
      if (manifest.version !== version || !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') {
        throw new Error(`Expected ${version} with a files object`);
      }
      return manifest;
    } catch (error) {
      fail('MANIFEST_INVALID', path, error.message);
      return null;
    }
  }

  function verifyFiles(manifest, label) {
    if (!manifest) return;
    for (const [relative, entry] of Object.entries(manifest.files)) {
      if (!validRelativePath(relative)) {
        fail('MANIFEST_PATH_INVALID', relative, 'Manifest paths must be safe relative POSIX paths');
        continue;
      }
      const path = `${CHEM_ROOT}/${relative}`;
      required.add(path);
      if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        fail('MANIFEST_ENTRY_INVALID', path, `${label} entry must contain SHA-256 and byte length`);
        continue;
      }
      try {
        if (!lstatSync(join(repoRoot, path)).isFile()) throw new Error('Expected a regular file');
        const data = readFileSync(join(repoRoot, path));
        if (data.length !== entry.bytes || hash(data) !== entry.sha256) {
          fail('FILE_HASH_MISMATCH', path, `${label} file does not match its recorded bytes and SHA-256`);
        }
      } catch (error) {
        fail('FILE_MISSING', path, error.message);
      }
    }
  }

  const snapshot = readManifest('snapshot-manifest.json', 'chem-source-snapshot/v1');
  if (snapshot) {
    counts.snapshotFiles = Object.keys(snapshot.files).length;
    if (counts.snapshotFiles !== 254) fail('SNAPSHOT_COUNT_MISMATCH', CHEM_ROOT, `Expected 254 immutable source files; found ${counts.snapshotFiles}`);
    if (hash(JSON.stringify(snapshot.files)) !== snapshot.sourceManifestHash) {
      fail('SNAPSHOT_MANIFEST_HASH_MISMATCH', `${CHEM_ROOT}/snapshot-manifest.json`, 'Immutable source manifest binding changed');
    }
  }
  verifyFiles(snapshot, 'Snapshot');
  const development = readManifest('development-manifest.json', 'chem-development-snapshot/v1');
  if (development) {
    counts.developmentFiles = Object.keys(development.files).length;
    if (snapshot && development.sourceManifestHash !== snapshot.sourceManifestHash) {
      fail('DEVELOPMENT_BINDING_MISMATCH', `${CHEM_ROOT}/development-manifest.json`, 'Development files must bind to the immutable source manifest');
    }
    if (snapshot) {
      for (const path of Object.keys(development.files)) {
        if (Object.hasOwn(snapshot.files, path)) fail('MANIFEST_OVERLAP', path, 'Development additions must not replace immutable source entries');
      }
    }
  }
  verifyFiles(development, 'Development');

  try {
    const tracked = new Set(git(['ls-files', '--cached', '-z']));
    counts.trackedPaths = tracked.size;
    counts.requiredPaths = required.size;
    for (const path of required) {
      if (!tracked.has(path)) fail('REQUIRED_NOT_TRACKED', path, 'Required public source is absent from the Git index');
      if (!existsSync(join(repoRoot, path))) fail('REQUIRED_MISSING', path, 'Required public source does not exist');
    }
    for (const path of tracked) {
      if (isForbiddenChemPath(path)) fail('FORBIDDEN_TRACKED_FILE', path, 'Generated, private, or model artifact is already tracked; ignore rules do not untrack files');
    }
    const source = new Set([...required, ...SOURCE_CANDIDATES,
      ...[...tracked].filter(path => sourceScopes.some(scope => path.startsWith(scope)))]);
    const candidates = [...source, ...IGNORED_CANDIDATES];
    // --no-index is essential: ordinary check-ignore silently skips tracked files.
    const ignored = new Set(git(['check-ignore', '--no-index', '-z', '--stdin'], `${candidates.join('\0')}\0`));
    for (const path of source) {
      if (ignored.has(path)) fail('SOURCE_IGNORED', path, 'Public source must remain visible to Git without force-add');
    }
    for (const path of IGNORED_CANDIDATES) {
      if (!ignored.has(path)) fail('PRIVATE_CANDIDATE_NOT_IGNORED', path, 'Representative local/generated artifact is not ignored');
    }
  } catch (error) {
    fail('GIT_CHECK_FAILED', '.', error.message);
  }
  return { ok: diagnostics.length === 0, scope: 'chem-source-publication', ...counts, diagnostics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--repo')) {
    console.error('Usage: node scripts/verify-chem-source-publication.mjs [--repo <repository>]');
    process.exitCode = 2;
  } else {
    const repoRoot = args[1] || resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const result = verifyChemSourcePublication(repoRoot);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }
}
