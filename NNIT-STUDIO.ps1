$ErrorActionPreference = "Stop"
Write-Host "NNIT Studio bootstrap" -ForegroundColor Cyan
Set-Location $PSScriptRoot

function Invoke-NpmStep {
    param([Parameter(Mandatory=$true)][string[]]$Args)
    & npm @Args
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20+ is required." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required." }
if (-not (Test-Path .env)) { Copy-Item .env.example .env }

Write-Host "Installing NNIT Studio dependencies..." -ForegroundColor Yellow
Invoke-NpmStep @("install")

Write-Host "Initializing database..." -ForegroundColor Yellow
Invoke-NpmStep @("run","db:init")

Write-Host "Running workspace checks..." -ForegroundColor Yellow
Invoke-NpmStep @("run","doctor")

Write-Host "Starting NNIT Studio API + Web..." -ForegroundColor Green
Invoke-NpmStep @("run","dev:core")
