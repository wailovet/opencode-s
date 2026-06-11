@echo off
setlocal

set "ROOT=%~dp0"
set "BUILD_DIR=%ROOT%build\vscode-app"
set "EXTENSION_DIR=%ROOT%packages\vscode-app"

where code >nul 2>&1
if errorlevel 1 (
  echo [dev-vscode] VS Code command "code" was not found in PATH.
  exit /b 1
)

if not exist "%EXTENSION_DIR%\package.json" (
  echo [dev-vscode] VS Code extension folder was not found: "%EXTENSION_DIR%"
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
echo [dev-vscode] Extension: "%EXTENSION_DIR%"
echo [dev-vscode] User data: "%BUILD_DIR%\user-data"
code ^
  --new-window ^
  --user-data-dir "%BUILD_DIR%\user-data" ^
  --extensions-dir "%BUILD_DIR%\extensions" ^
  --extensionDevelopmentPath="%EXTENSION_DIR%" ^
  --log trace ^
  "%EXTENSION_DIR%"

exit /b %errorlevel%
