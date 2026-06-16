@echo off
setlocal

set "ROOT=%~dp0"
set "EXT_DIR=%ROOT%packages\vscode-app"
set "APP_DIST_DIR=%ROOT%packages\app\dist"
set "OPENCODE_DIR=%ROOT%packages\opencode"
set "OUT_DIR=%ROOT%build\vscode-vsix"
set "STAGE_DIR=%OUT_DIR%\staging"
set "VSIX_FILE=%OUT_DIR%\opencode-vscode-app.vsix"
rem build.ts --single hardcodes its output to packages\opencode\dist\opencode-windows-x64\bin\opencode(.exe)
set "OPENCODE_EXE=%OPENCODE_DIR%\dist\opencode-windows-x64\bin\opencode.exe"
set "SKIP_VSIX=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--skip-vsix" set "SKIP_VSIX=1"
if /i "%~1"=="--skip-opencode" set "SKIP_OPENCODE=1"
shift
goto :parse_args
:args_done

if not exist "%EXT_DIR%\package.json" (
  echo [error] Cannot find VS Code extension package: "%EXT_DIR%\package.json"
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [error] node.exe was not found in PATH.
  exit /b 1
)

where npx >nul 2>nul
if errorlevel 1 (
  echo [error] npx.cmd was not found in PATH.
  exit /b 1
)

where bun >nul 2>nul
if errorlevel 1 (
  echo [error] bun.exe was not found in PATH.
  exit /b 1
)

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if errorlevel 1 exit /b 1

echo [0/4] Cleaning previous build artifacts...
taskkill /f /im opencode.exe >nul 2>nul
taskkill /f /im node.exe >nul 2>nul
if exist "%STAGE_DIR%" (
  for /l %%i in (1,1,5) do (
    timeout /t 1 /nobreak >nul
    rmdir /s /q "%STAGE_DIR%" 2>nul
    if not exist "%STAGE_DIR%" goto :stage_cleaned
  )
  echo [error] Cannot remove "%STAGE_DIR%" - file is locked.
  exit /b 1
)
:stage_cleaned

mkdir "%STAGE_DIR%"
if errorlevel 1 exit /b 1

pushd "%EXT_DIR%" >nul
if errorlevel 1 exit /b 1

echo [1/4] Checking extension JavaScript...
call npm run check
if errorlevel 1 (
  popd >nul
  exit /b 1
)

popd >nul

echo [2/4] Building opencode runtime binary...
if "%SKIP_OPENCODE%"=="1" if exist "%OPENCODE_EXE%" (
  echo       Skipping opencode build ^(existing binary detected^).
  goto :opencode_done
)
if exist "%OPENCODE_DIR%\dist" rmdir /s /q "%OPENCODE_DIR%\dist"
if errorlevel 1 exit /b 1

call bun run "%OPENCODE_DIR%\script\build.ts" --single
if errorlevel 1 exit /b 1

if not exist "%OPENCODE_EXE%" (
  echo [error] Cannot find built runtime binary: "%OPENCODE_EXE%"
  exit /b 1
)
:opencode_done

echo [*] Building web application dist...
if exist "%APP_DIST_DIR%" rmdir /s /q "%APP_DIST_DIR%"
pushd "%ROOT%packages\app"
call bun run build
if errorlevel 1 (
  echo [error] App build failed.
  popd
  exit /b 1
)
popd

echo [3/4] Preparing package staging directory...
copy "%EXT_DIR%\package.json" "%STAGE_DIR%\" >nul
if errorlevel 1 exit /b 1

copy "%EXT_DIR%\README.md" "%STAGE_DIR%\" >nul
if errorlevel 1 exit /b 1

copy "%EXT_DIR%\.vscodeignore" "%STAGE_DIR%\" >nul
if errorlevel 1 exit /b 1

copy "%EXT_DIR%\vite.config.override.ts" "%STAGE_DIR%\" >nul
if errorlevel 1 exit /b 1

xcopy "%EXT_DIR%\src" "%STAGE_DIR%\src\" /e /i /y >nul
if errorlevel 1 exit /b 1

xcopy "%EXT_DIR%\media" "%STAGE_DIR%\media\" /e /i /y >nul
if errorlevel 1 exit /b 1

xcopy "%EXT_DIR%\.vscode" "%STAGE_DIR%\.vscode\" /e /i /y >nul
if errorlevel 1 exit /b 1

mkdir "%STAGE_DIR%\runtime\bin"
if errorlevel 1 exit /b 1

copy "%OPENCODE_EXE%" "%STAGE_DIR%\runtime\bin\" >nul
if errorlevel 1 exit /b 1

xcopy "%APP_DIST_DIR%" "%STAGE_DIR%\runtime\web\dist\" /e /i /y >nul
if errorlevel 1 exit /b 1

pushd "%STAGE_DIR%" >nul
if errorlevel 1 exit /b 1

if "%SKIP_VSIX%"=="1" (
  echo [4/4] Skipping VSIX packaging ^(--skip-vsix^).
  echo.
  echo [ok] Staging directory ready:
  echo %STAGE_DIR%
  popd >nul
  endlocal
  exit /b 0
)

echo [4/4] Packaging VSIX...
if exist "%VSIX_FILE%" del /f /q "%VSIX_FILE%"
call npx --yes @vscode/vsce package --allow-missing-repository --skip-license --out "%VSIX_FILE%"
if errorlevel 1 (
  popd >nul
  exit /b 1
)

popd >nul

echo.
echo [ok] VSIX created:
echo %VSIX_FILE%

endlocal
