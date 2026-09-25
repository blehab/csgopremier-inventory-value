@echo off
setlocal enabledelayedexpansion

rem ---------------------------------------------------------------------------
rem  CSGOPremier Inventory Value - installer / updater
rem
rem  Downloads the latest release from GitHub into
rem      %LOCALAPPDATA%\csgopremier-inventory-value
rem  creating that folder on first run and replacing the files in it after that.
rem  Keep this script wherever you like - the install folder is fixed, so it
rem  does not matter where you run it from.
rem
rem  Chrome will not notice by itself: when this finishes, open
rem  chrome://extensions and press the reload arrow on the extension's card.
rem
rem  Usage:  update.bat [target folder]
rem  Pass a folder only if you want to install somewhere other than the default.
rem ---------------------------------------------------------------------------

set "REPO=blehab/csgopremier-inventory-value"
set "ASSET=csgopremier-inventory-value.zip"
set "URL=https://github.com/%REPO%/releases/latest/download/%ASSET%"
set "INSTALLDIR=%LOCALAPPDATA%\csgopremier-inventory-value"

if "%~1"=="" (set "TARGET=%INSTALLDIR%") else (set "TARGET=%~f1")
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

echo CSGOPremier Inventory Value - installer / updater
echo Install folder: %TARGET%
echo.

where curl.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: curl.exe was not found. It ships with Windows 10 1803 and later.
  goto :fail
)
where tar.exe >nul 2>&1
if errorlevel 1 (
  echo ERROR: tar.exe was not found. It ships with Windows 10 1803 and later.
  goto :fail
)

if not exist "%TARGET%\" mkdir "%TARGET%"
if not exist "%TARGET%\" (
  echo ERROR: could not create %TARGET%
  goto :fail
)

call :readversion "%TARGET%\manifest.json" BEFORE

set "WORK=%TEMP%\cip-update-%RANDOM%%RANDOM%"
mkdir "%WORK%"
if not exist "%WORK%\" (
  echo ERROR: could not create a temporary folder in %TEMP%
  goto :fail
)

echo Downloading the latest release...
curl -fL --retry 3 --retry-delay 2 --progress-bar -o "%WORK%\%ASSET%" "%URL%"
if errorlevel 1 (
  echo ERROR: the download failed. Check your connection, or whether a release exists at
  echo        https://github.com/%REPO%/releases/latest
  goto :fail
)

rem Refuse to unpack anything that is not this extension.
tar -tf "%WORK%\%ASSET%" | findstr /x /c:"manifest.json" >nul
if errorlevel 1 (
  echo ERROR: the downloaded archive has no manifest.json at its root, so it is not the
  echo        extension. Nothing was extracted.
  goto :fail
)

echo Replacing files in %TARGET% ...
tar -xf "%WORK%\%ASSET%" -C "%TARGET%"
if errorlevel 1 (
  echo ERROR: extracting failed. Is one of the files open in another program?
  goto :fail
)

call :readversion "%TARGET%\manifest.json" AFTER

echo.
if "%BEFORE%"=="" (
  echo Installed version %AFTER%.
) else if "%BEFORE%"=="%AFTER%" (
  echo Already on version %AFTER% - files refreshed anyway.
) else (
  echo Updated %BEFORE% to %AFTER%.
)

rd /s /q "%WORK%" 2>nul

echo.
if "%BEFORE%"=="" (
  echo Next: open chrome://extensions, turn on Developer mode, choose
  echo       "Load unpacked" and pick this folder:
  echo         %TARGET%
  <nul set /p "=%TARGET%"|clip 2>nul
  if not errorlevel 1 (
    echo.
    echo       ^(that path is now on your clipboard^)
  )
) else (
  echo Next: open chrome://extensions and press the reload arrow on the
  echo       "CSGOPremier Inventory Value" card.
)
echo.
pause
exit /b 0

:fail
if defined WORK rd /s /q "%WORK%" 2>nul
echo.
echo Update aborted.
echo.
pause
exit /b 1

rem --- reads "version" from a manifest.json into the variable named by %2 ---
:readversion
setlocal enabledelayedexpansion
set "v="
if exist %1 (
  for /f "tokens=2 delims=:" %%a in ('findstr /c:"\"version\"" %1') do if not defined v set "v=%%a"
)
if defined v set "v=!v: =!"
if defined v set v=!v:"=!
if defined v set "v=!v:,=!"
endlocal & set "%~2=%v%"
goto :eof
