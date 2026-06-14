@echo off
setlocal

set "ROOT=%~dp0"
set "BUILD_DIR=%ROOT%build\vscode-app"
set "STAGE_DIR=%ROOT%build\vscode-vsix\staging"

where code >nul 2>&1
if errorlevel 1 (
  echo [dev-vscode] VS Code command "code" was not found in PATH.
  exit /b 1
)

if defined BUN_EXE (
  if not exist "%BUN_EXE%" (
    echo [dev-vscode] BUN_EXE does not exist: "%BUN_EXE%"
    exit /b 1
  )
  for %%I in ("%BUN_EXE%") do set "PATH=%%~dpI;%PATH%"
) else (
  if exist "D:\bun.exe" (
    set "BUN_EXE=D:\bun.exe"
    set "PATH=D:\;%PATH%"
  )
)

if not exist "%BUILD_DIR%\user-data" mkdir "%BUILD_DIR%\user-data"
if not exist "%BUILD_DIR%\extensions" mkdir "%BUILD_DIR%\extensions"

cd /d "%ROOT%"

echo [dev-vscode] Building staging directory (no VSIX, no opencode rebuild)...
call "%ROOT%build-vscode-vsix.bat" --skip-vsix --skip-opencode
if errorlevel 1 (
  echo [dev-vscode] Build failed.
  exit /b 1
)

if not exist "%STAGE_DIR%\src\extension.js" (
  echo [dev-vscode] Staging directory not ready: "%STAGE_DIR%\src\extension.js"
  exit /b 1
)

echo [dev-vscode] Extension: "%STAGE_DIR%"
echo [dev-vscode] User data: "%BUILD_DIR%\user-data"
code ^
  --new-window ^
  --user-data-dir "%BUILD_DIR%\user-data" ^
  --extensions-dir "%BUILD_DIR%\extensions" ^
  --extensionDevelopmentPath="%STAGE_DIR%" ^
  --log trace ^
  "%ROOT%"

exit /b %errorlevel%
