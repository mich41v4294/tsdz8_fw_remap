$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "webapp")
$Port = 8080

Write-Host "Opening http://localhost:$Port"
Start-Process "http://localhost:$Port"
Write-Host "Starting the patcher. Leave this window open. Close it to stop the server."

$env:PORT = "$Port"
if (Get-Command py -ErrorAction SilentlyContinue) {
  py -3 serve.py
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  python serve.py
} else {
  Write-Host "Python 3 is not installed or not on PATH."
  Write-Host "Install it from https://www.python.org then run this again."
  exit 1
}
