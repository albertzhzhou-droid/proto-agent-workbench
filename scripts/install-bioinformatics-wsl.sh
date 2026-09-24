#!/usr/bin/env bash
# User-space Ubuntu/WSL installation; never changes the system Python or R.
set -euo pipefail
bio_root="${PROTO_BIO_ROOT:-$HOME/.local/share/proto-bio}"
mkdir -p "$bio_root/bootstrap" "$bio_root/locks" "$bio_root/logs"
export MAMBA_ROOT_PREFIX="$bio_root/mamba"
export MAMBA_USE_SHARDED_REPODATA=false
if [[ ! -x "$bio_root/bin/micromamba" ]]; then
  curl --fail --location --retry 3 https://micro.mamba.pm/api/micromamba/linux-64/latest -o "$bio_root/bootstrap/micromamba.tar.bz2"
  sha256sum "$bio_root/bootstrap/micromamba.tar.bz2" > "$bio_root/bootstrap/micromamba.sha256"
  python3 - "$bio_root" <<'PY'
import os, sys, tarfile
root = sys.argv[1]
with tarfile.open(os.path.join(root, 'bootstrap/micromamba.tar.bz2')) as archive:
    archive.extract('bin/micromamba', path=root, filter='data')
PY
fi
install_env() {
  local env_name="$1"; shift
  "$bio_root/bin/micromamba" create --yes --strict-channel-priority --override-channels -c conda-forge -c bioconda -p "$bio_root/envs/$env_name" "$@" 2>&1 | tee "$bio_root/logs/$env_name-install.log"
  "$bio_root/bin/micromamba" list -p "$bio_root/envs/$env_name" --explicit > "$bio_root/locks/$env_name-linux-64.txt"
}
case "${1:-all}" in
  variants) install_env variants gatk4 samtools bcftools snpeff ;;
  lumpy) install_env lumpy lumpy-sv samtools ;;
  cnvkit) install_env cnvkit cnvkit ;;
  prokka) install_env prokka prokka ;;
  deseq2) install_env deseq2 bioconductor-deseq2 ;;
  mummer) install_env mummer mummer4 ;;
  all)
    install_env variants gatk4 samtools bcftools snpeff
    install_env lumpy lumpy-sv samtools
    install_env cnvkit cnvkit
    install_env prokka prokka
    install_env deseq2 bioconductor-deseq2
    install_env mummer mummer4
    ;;
  *) echo 'Choose all, variants, lumpy, cnvkit, prokka, deseq2 or mummer.' >&2; exit 2 ;;
esac
