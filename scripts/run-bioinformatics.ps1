param(
  [Parameter(Mandatory=$true)][ValidateSet('gatk','samtools','bcftools','snpEff','lumpy','cnvkit','prokka','deseq2','nucmer','show-coords')][string]$Tool,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$ToolArguments
)
$ErrorActionPreference='Stop'
$engines=@{
  gatk=@('variants','gatk'); samtools=@('variants','samtools'); bcftools=@('variants','bcftools'); snpEff=@('variants','snpEff')
  lumpy=@('lumpy','lumpy'); cnvkit=@('cnvkit','cnvkit.py'); prokka=@('prokka','prokka'); deseq2=@('deseq2','Rscript'); nucmer=@('mummer','nucmer'); 'show-coords'=@('mummer','show-coords')
}
$engine=$engines[$Tool]
$bioRoot='/home/openclaw/.local/share/proto-bio'
& wsl.exe -d Ubuntu-24.04 -- "$bioRoot/bin/micromamba" run -p "$bioRoot/envs/$($engine[0])" $engine[1] @ToolArguments
exit $LASTEXITCODE
