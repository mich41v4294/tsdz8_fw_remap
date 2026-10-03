$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$venvDir = Join-Path $PSScriptRoot "tools\jlink_flasher\.venv"
$venvPy = Join-Path $venvDir "Scripts\python.exe"

function Find-Python {
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher) {
    return @{ Exe = "py"; Extra = @("-3") }
  }
  foreach ($name in @("python3", "python")) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) {
      return @{ Exe = $found.Source; Extra = @() }
    }
  }
  return $null
}

if (-not (Test-Path $venvPy)) {
  Write-Host "Creating virtual environment..."
  $python = Find-Python
  if (-not $python) {
    Write-Host "Python 3 is not installed or not on PATH."
    Write-Host "Install from https://www.python.org then run this again."
    Write-Host "SEGGER J-Link software is also required: https://www.segger.com/downloads/jlink/"
    exit 1
  }
  & $python.Exe @($python.Extra) -m venv $venvDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Installing J-Link flasher dependencies..."
& $venvPy -m pip install -q -r (Join-Path $PSScriptRoot "tools\jlink_flasher\requirements.txt")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $venvPy -m tools.jlink_flasher @args
exit $LASTEXITCODE
