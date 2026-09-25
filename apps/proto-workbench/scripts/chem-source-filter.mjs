// Keep authored Chem source and development support while excluding local state.
// package.json repeats this exact profile because electron-builder reads JSON;
// the packaging regression checks its real FileMatcher against this predicate.
export const CHEM_SOURCE_FILTERS = Object.freeze([
  "**/*",
  "!**/{.venv,.venv-*,venv,.chem-backends,__pycache__,build,dist,scratch,node_modules,.cache,.pytest_cache,.mypy_cache,.ruff_cache,.uv-cache,.vite,.vite-temp,.npm-cache,.pnpm-store,htmlcov,coverage,*.egg-info}{,/**/*}",
  "!**/{timer.dat,.env,.env.!(example),*.env,.coverage,.coverage.*,*.pyc,*.pyo,*.gguf,*.safetensors,*.onnx,*.pt,*.pth}",
]);

const excludedDirectory = /^(?:\.venv(?:-.*)?|venv|\.chem-backends|__pycache__|build|dist|scratch|node_modules|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.uv-cache|\.vite|\.vite-temp|\.npm-cache|\.pnpm-store|htmlcov|coverage|.*\.egg-info)$/;
const excludedFile = /^(?:timer\.dat|\.env(?:\..*)?|\.coverage(?:\..*)?)$|\.(?:env|pyc|pyo|gguf|safetensors|onnx|pt|pth)$/;

export function isExcludedChemSource(relativePath) {
  const pieces = relativePath.replaceAll("\\", "/").split("/");
  if (pieces.some(piece => excludedDirectory.test(piece))) return true;
  const name = pieces.at(-1);
  return name !== ".env.example" && excludedFile.test(name);
}
