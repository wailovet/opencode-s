@echo off
setlocal

set "ROOT=%~dp0"
set "BUILD_DIR=%ROOT%build"

if defined BUN_EXE (
  if not exist "%BUN_EXE%" (
    echo [dev] BUN_EXE does not exist: "%BUN_EXE%"
    exit /b 1
  )
  for %%I in ("%BUN_EXE%") do set "PATH=%%~dpI;%PATH%"
) else (
  where bun >nul 2>&1
  if errorlevel 1 (
    echo [dev] Bun was not found in PATH. Set BUN_EXE to the full path of bun.exe.
    exit /b 1
  )
  set "BUN_EXE=bun"
)

if not exist "%ROOT%node_modules" (
  echo [dev] Dependencies are missing. Run "%BUN_EXE%" install first.
  exit /b 1
)

if not exist "%BUILD_DIR%\cache\bun-install" mkdir "%BUILD_DIR%\cache\bun-install"
if not exist "%BUILD_DIR%\cache\bun-runtime" mkdir "%BUILD_DIR%\cache\bun-runtime"
if not exist "%BUILD_DIR%\tmp" mkdir "%BUILD_DIR%\tmp"

set "BUN_INSTALL_CACHE_DIR=%BUILD_DIR%\cache\bun-install"
set "BUN_RUNTIME_TRANSPILER_CACHE_PATH=%BUILD_DIR%\cache\bun-runtime"
set "OPENCODE_BUILD_DIR=%BUILD_DIR%"
set "TEMP=%BUILD_DIR%\tmp"
set "TMP=%BUILD_DIR%\tmp"
set "TMPDIR=%BUILD_DIR%\tmp"

cd /d "%ROOT%"
echo [dev] Backend: http://localhost:4096
echo [dev] Web:     http://localhost:4444
start "OpenCode Backend :4096" /D "%ROOT%packages\opencode" "%BUN_EXE%" run --conditions=browser ./src/index.ts serve --port 4096
"%BUN_EXE%" run --cwd packages/app dev -- --port 4444 %*
exit /b %errorlevel%
