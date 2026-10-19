@echo off
title 플레이리스트 팩토리 - 서버
cd /d "%~dp0"

echo ============================================================
echo   플레이리스트 팩토리  (Treblo API + ffmpeg)
echo ============================================================
echo.

rem winget 으로 설치된 프로그램은 새 창 전에는 PATH 에 없을 수 있어 기본 경로를 더해 둔다
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
if exist "%LocalAppData%\Microsoft\WinGet\Links" set "PATH=%PATH%;%LocalAppData%\Microsoft\WinGet\Links"
for /d %%d in ("%LocalAppData%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*") do for /d %%e in ("%%d\ffmpeg-*") do set "PATH=%PATH%;%%e\bin"

where node >nul 2>&1
if errorlevel 1 (
  echo [안내] Node.js 가 설치되어 있지 않습니다. 이 앱은 Node.js 로 실행됩니다.
  echo        install.bat 을 실행해 Node.js 와 의존성을 자동 설치합니다. 관리자 권한 창이 뜨면 [예]를 누르세요.
  echo.
  call "%~dp0install.bat" auto
  if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
)
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [오류] Node.js 가 없어 실행할 수 없습니다.
  echo        방금 설치됐다면 이 창을 닫고 START.bat 을 다시 실행하세요 ^(새 PATH 는 새 창에서 적용^).
  echo        설치가 안 됐다면 https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [경고] ffmpeg 를 찾을 수 없습니다. 영상 렌더링에 필요합니다. install.bat 을 실행하면 winget 으로 설치를 시도합니다.
)

if not exist "node_modules\" (
  echo 의존성이 설치되어 있지 않습니다. install.bat 을 실행합니다...
  call "%~dp0install.bat" auto
  if errorlevel 1 (
    echo [오류] 의존성 설치에 실패했습니다. 위 메시지를 확인하세요.
    pause
    exit /b 1
  )
)

for /f %%p in ('node -p "try{JSON.parse(require('fs').readFileSync('config.json','utf8')).port||5177}catch(e){5177}"') do set PORT=%%p
if "%PORT%"=="" set PORT=5177

echo 브라우저를 엽니다: http://localhost:%PORT%
echo.
echo  * 앱 종료: 화면 우측 상단의 빨간 [종료] 버튼
echo  * 비상 종료(화면이 멈췄거나 창을 닫아 버린 경우): STOP.bat 실행
echo  * 사용설명서: 화면 상단 [설명서] 버튼 또는 사용설명서.html
echo.

rem 서버가 뜨면 서버가 앱 전용 창(Edge/Chrome --app, 별도 프로필)을 연다. [종료] 때 이 창만 닫혀 다른 브라우저 탭은 그대로 남는다
set "PF_OPEN_BROWSER=1"
node "%~dp0server\index.js"
echo.
echo 서버가 종료되었습니다.
timeout /t 3 >nul
