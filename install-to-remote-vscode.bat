@echo off
setlocal

set "ROOT=%~dp0"
set "TARGET_ROOT=%~1"
if "%TARGET_ROOT%"=="" set "TARGET_ROOT=D:\code-home\openvscode-server-patch\build\dist\win-unpacked"

set "SERVER_EXTENSIONS_DIR=%TARGET_ROOT%\resources\server\lib\vscode\extensions"
set "EXTENSION_ID=opencode-dev.opencode-vscode-app"
set "INSTALL_DIR=%SERVER_EXTENSIONS_DIR%\%EXTENSION_ID%"
set "STAGE_DIR=%ROOT%build\vscode-vsix\staging"

if not exist "%TARGET_ROOT%\open-vscode.exe" (
  echo [error] Cannot find open-vscode.exe under:
  echo         "%TARGET_ROOT%"
  echo.
  echo Usage:
  echo   %~nx0 [win-unpacked-directory]
  exit /b 1
)

if not exist "%SERVER_EXTENSIONS_DIR%" (
  echo [error] Cannot find remote VS Code server extensions directory:
  echo         "%SERVER_EXTENSIONS_DIR%"
  exit /b 1
)

echo [1/2] Building extension package...
call "%ROOT%build-vscode-vsix.bat"
if errorlevel 1 exit /b 1

if not exist "%STAGE_DIR%\package.json" (
  echo [error] Cannot find staged extension package:
  echo         "%STAGE_DIR%\package.json"
  exit /b 1
)

echo [2/2] Installing extension to remote VS Code server...
echo       "%INSTALL_DIR%"

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 exit /b 1

if exist "%INSTALL_DIR%\runtime\bin\opencode.exe" (
  echo       Existing runtime detected; preserving runtime because it may be in use.
  robocopy "%STAGE_DIR%" "%INSTALL_DIR%" /mir /r:2 /w:1 /xd runtime memory poc >nul
  if errorlevel 8 (
    echo [error] robocopy failed with exit code %errorlevel%.
    exit /b 1
  )
  robocopy "%STAGE_DIR%\runtime\web" "%INSTALL_DIR%\runtime\web" /mir /r:2 /w:1 >nul
) else (
  robocopy "%STAGE_DIR%" "%INSTALL_DIR%" /mir /r:2 /w:1 /xd memory poc >nul
)
if errorlevel 8 (
  echo [error] robocopy failed with exit code %errorlevel%.
  exit /b 1
)

echo.
echo [ok] Installed:
echo %INSTALL_DIR%
echo.
echo Restart the remote VS Code server process to load the updated extension.

endlocal
exit /b 0
