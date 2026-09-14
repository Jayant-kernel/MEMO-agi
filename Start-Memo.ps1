param(
  [Parameter(Mandatory = $true)]
  [string]$Project,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$OpenCodeArgs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$memoRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd("\\")
$projectPath = [System.IO.Path]::GetFullPath($Project)
$projectPrefix = $memoRoot + "\"

if (-not ($projectPath.Equals($memoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or $projectPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase))) {
  throw "Project must be inside $memoRoot"
}

if (-not (Test-Path -LiteralPath $projectPath -PathType Container)) {
  throw "Project folder does not exist: $projectPath"
}

$env:OPENCODE_CONFIG = Join-Path $memoRoot "opencode.jsonc"
$env:OPENCODE_CONFIG_DIR = Join-Path $memoRoot ".opencode"

Push-Location -LiteralPath $projectPath
try {
  & npx --no-install opencode-ai @OpenCodeArgs
} finally {
  Pop-Location
}
