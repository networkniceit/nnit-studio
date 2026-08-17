$ErrorActionPreference='Stop'
Write-Host 'NNIT Studio V2 bootstrap' -ForegroundColor Cyan
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'Node.js is required.'}
if(-not (Test-Path '.env')){Copy-Item '.env.example' '.env'}
Write-Host 'Installing/updating workspace dependencies...'
npm install
if($LASTEXITCODE -ne 0){throw 'npm install failed'}
Write-Host 'Running type checks...'
npm run typecheck
if($LASTEXITCODE -ne 0){throw 'Type checking failed'}
Write-Host 'Starting NNIT Studio V2 at http://localhost:5173/' -ForegroundColor Green
npm run dev:core
