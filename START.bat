@echo off
title 플레이리스트 팩토리 - 서버
cd /d "%~dp0"

echo ============================================================
echo   플레이리스트 팩토리  (Treblo API + ffmpeg)
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [경고] ffmpeg 를 찾을 수 없습니다. 영상 렌더링에 필요합니다. install.bat 의 안내를 참고하세요.
)

if not exist "node_modules\" (
  echo 의존성이 설치되어 있지 않습니다. install.bat 을 실행합니다...
  call install.bat
  if errorlevel 1 (
    echo [오류] 의존성 설치에 실패했습니다.
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

start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%"
node "%~dp0server\index.js"
echo.
echo 서버가 종료되었습니다.
timeout /t 3 >nul
