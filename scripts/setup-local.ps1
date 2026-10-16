param(
  [string]$PostingAgentPath = 'C:\Users\Pranav Gupta\OneDrive - Ken Research Private Limited\Desktop\Read Me\reponse\x-posting-agent'
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$source = (Resolve-Path -LiteralPath $PostingAgentPath).Path
$sourceEnv = Join-Path $source '.env'
$credentials = Join-Path $source '.accounts\google-service-account.json'
if (-not (Test-Path -LiteralPath $sourceEnv -PathType Leaf)) { throw "Existing API .env was not found: $sourceEnv" }
if (-not (Test-Path -LiteralPath $credentials -PathType Leaf)) { throw "Google service account was not found: $credentials" }
$localEnv = Join-Path $project '.env'
if (Test-Path -LiteralPath $localEnv) { throw "Local .env already exists. Review it before replacing: $localEnv" }
$sourceEnvForDotenv = $sourceEnv.Replace('\', '/')
$credentialsForDotenv = $credentials.Replace('\', '/')
$lines = @(
  '# Paths to existing resources. No API keys or service-account JSON are copied.',
  "CE_ENV_FILE=`"$sourceEnvForDotenv`"",
  "CE_GOOGLE_SA_FILE=`"$credentialsForDotenv`"",
  'HCE_HERMES_BIN=hermes',
  'CE_REWRITE_MAX_ROUNDS=2',
  'CE_DRY_RUN=true',
  'CE_SHADOW_MODE=true',
  'CE_PLATFORMS_ENABLED=',
  'CE_SHEET_TAB="Social Media"',
  'CE_TEXT_PROVIDERS=ollama,groq,openrouter,nvidia'
)
[System.IO.File]::WriteAllText($localEnv, ($lines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
Write-Output "Created private .env with paths to the existing API and Google credential files: $localEnv"
