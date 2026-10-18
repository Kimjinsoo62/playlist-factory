@echo off
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
echo [1/4] Node 패키지 설치 (express, MCP SDK)...
call npm install --no-fund --no-audit
if errorlevel 1 ( echo [오류] npm install 실패 & exit /b 1 )

echo.
echo [2/4] Python 패키지 확인 (Pillow: 썸네일/배경 생성)...
where python >nul 2>&1
if errorlevel 1 (
  echo [경고] Python 이 없습니다. https://www.python.org 에서 3.10 이상을 설치하고 PATH 에 추가하세요.
) else (
  python -c "import PIL" >nul 2>&1
  if errorlevel 1 ( python -m pip install --quiet pillow ) else ( echo   Pillow 설치됨 )
)

echo.
echo [3/4] ffmpeg 확인...
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [경고] ffmpeg 가 없습니다. 다음 중 하나로 설치하세요:
  echo    winget install Gyan.FFmpeg
  echo    또는 https://www.gyan.dev/ffmpeg/builds/ 에서 essentials 빌드를 받아 PATH 에 추가
) else (
  for /f "tokens=3" %%v in ('ffmpeg -version 2^>^&1 ^| findstr /b "ffmpeg version"') do echo   ffmpeg %%v 설치됨
)

echo.
echo [4/4] git 확인 (앱 화면의 [업데이트] 버튼이 GitHub 에서 새 버전을 받는 데 필요)...
set "REPO_URL=https://github.com/Kimjinsoo62/playlist-factory.git"
where git >nul 2>&1
if errorlevel 1 (
  echo   git 이 없습니다. winget 으로 설치를 시도합니다...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [경고] winget 이 없어 자동 설치를 못 합니다. https://git-scm.com/download/win 에서 설치한 뒤 install.bat 을 다시 실행하세요.
  ) else (
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
  )
  rem 방금 설치한 git 은 이 창의 PATH 에 아직 없으므로 기본 설치 경로를 더한다
  if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
  if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "PATH=%PATH%;%LocalAppData%\Programs\Git\cmd"
)
where git >nul 2>&1
if errorlevel 1 (
  echo [경고] git 을 쓸 수 없어 [업데이트] 버튼이 동작하지 않습니다. 앱 실행에는 지장이 없습니다.
  goto :done
)
for /f "tokens=3" %%v in ('git --version') do echo   git %%v 설치됨
if exist ".git\" (
  git remote get-url origin >nul 2>&1
  if errorlevel 1 (
    echo   원격 저장소가 없어 origin 을 추가합니다: %REPO_URL%
    git remote add origin "%REPO_URL%"
  )
  echo   git 저장소 연결됨. 새 버전은 앱의 [업데이트] 버튼으로 받습니다.
  goto :done
)
rem ZIP 으로 받았거나 폴더만 복사한 경우: git 저장소로 만들고 GitHub 의 최신 코드에 맞춘다.
rem config.json, input/, output/ 등 git 이 관리하지 않는 파일은 그대로 두고, 기본 프리셋 등 저장소 파일만 최신으로 덮어쓴다.
echo   git 저장소가 아닙니다 (ZIP 다운로드 또는 폴더 복사). GitHub 에 연결하고 최신 코드에 맞춥니다...
git init -q
git remote add origin "%REPO_URL%"
git fetch -q origin main
if errorlevel 1 (
  echo [경고] GitHub 에 연결하지 못했습니다. 인터넷 연결을 확인하세요. 앱은 그대로 실행되며, 나중에 install.bat 을 다시 실행하면 연결합니다.
  rmdir /s /q ".git"
  goto :done
)
rem 아래 괄호 블록은 통째로 읽힌 뒤 실행된다. checkout 이 이 파일(install.bat)을 새 버전으로 덮어써도 끝까지 진행되도록 마무리까지 한 블록에 둔다.
(
  git checkout -q -f -B main origin/main
  if errorlevel 1 (
    echo [경고] 저장소 연결에 실패했습니다. 앱 실행에는 지장이 없습니다.
  ) else (
    echo   연결 완료. 이후 새 버전은 앱의 [업데이트] 버튼으로 받습니다.
    echo   최신 코드에 맞춰 Node 패키지를 다시 설치합니다...
    call npm install --no-fund --no-audit
  )
  echo.
  echo 설치가 끝났습니다. START.bat 으로 실행하세요.
  echo Treblo API 키는 앱 화면의 [설정]에서 입력합니다. ^(https://treblo.com/developers^)
  if "%~1"=="" pause
  exit /b 0
)

:done
echo.
echo 설치가 끝났습니다. START.bat 으로 실행하세요.
echo Treblo API 키는 앱 화면의 [설정]에서 입력합니다. (https://treblo.com/developers)
if "%~1"=="" pause
exit /b 0
