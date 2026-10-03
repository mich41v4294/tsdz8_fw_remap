$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "webapp")

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or not on PATH."
  Write-Host "Install the LTS build from https://nodejs.org then run this again."
  exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host "npm is not on PATH. Reinstall Node.js LTS from https://nodejs.org"
  exit 1
}

Write-Host "Installing dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Opening http://localhost:5173"
Start-Process "http://localhost:5173"
Write-Host "Starting the patcher. Leave this window open. Close it to stop the server."
npm run dev
