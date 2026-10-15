@echo off
chcp 65001 >nul
title 플레이리스트 팩토리 - 의존성 설치
cd /d "%~dp0"

echo ============================================================
echo   플레이리스트 팩토리 - 의존성 설치
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 필요합니다. https://nodejs.org 에서 LTS 를 설치하세요.
  exit /b 1
)
echo [1/3] Node 패키지 설치 (express, MCP SDK)...
call npm install --no-fund --no-audit
if errorlevel 1 ( echo [오류] npm install 실패 & exit /b 1 )

echo.
echo [2/3] Python 패키지 확인 (Pillow: 썸네일/배경 생성)...
where python >nul 2>&1
if errorlevel 1 (
  echo [경고] Python 이 없습니다. https://www.python.org 에서 3.10 이상을 설치하고 PATH 에 추가하세요.
) else (
  python -c "import PIL" >nul 2>&1
  if errorlevel 1 ( python -m pip install --quiet pillow ) else ( echo   Pillow 설치됨 )
)

echo.
echo [3/3] ffmpeg 확인...
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [경고] ffmpeg 가 없습니다. 다음 중 하나로 설치하세요:
  echo    winget install Gyan.FFmpeg
  echo    또는 https://www.gyan.dev/ffmpeg/builds/ 에서 essentials 빌드를 받아 PATH 에 추가
) else (
  for /f "tokens=3" %%v in ('ffmpeg -version 2^>^&1 ^| findstr /b "ffmpeg version"') do echo   ffmpeg %%v 설치됨
)

echo.
echo 설치가 끝났습니다. START.bat 으로 실행하세요.
echo Treblo API 키는 앱 화면의 [설정]에서 입력합니다. (https://treblo.com/developers)
if "%~1"=="" pause
exit /b 0
