@echo off
chcp 65001 >nul
title 플레이리스트 팩토리 - 비상 종료
cd /d "%~dp0"
set ROOT=%~dp0
set ROOT=%ROOT:~0,-1%

for /f %%p in ('node -p "try{JSON.parse(require('fs').readFileSync('config.json','utf8')).port||5177}catch(e){5177}" 2^>nul') do set PORT=%%p
if "%PORT%"=="" set PORT=5177

echo ============================================================
echo   플레이리스트 팩토리 - 비상 종료 (포트 %PORT%)
echo ============================================================
echo.

echo [1] 서버에 종료 API 호출 시도 (POST /api/shutdown)...
curl -s -m 5 -X POST http://localhost:%PORT%/api/shutdown >nul 2>&1
if not errorlevel 1 (
  echo     서버가 응답했습니다. [종료] 버튼과 같은 절차로 정리합니다. 5초 대기...
  timeout /t 5 /nobreak >nul
) else (
  echo     서버가 응답하지 않습니다. 직접 정리합니다.
)

echo [2] 캐시 삭제...
if exist "cache\" ( del /q /s "cache\*" >nul 2>&1 & for /d %%d in ("cache\*") do rd /s /q "%%d" >nul 2>&1 )

echo [3] 이 앱의 서버 프로세스 종료 (명령줄에 프로젝트 경로가 포함된 node/ffmpeg/python 만)...
powershell -NoProfile -NonInteractive -Command ^
  "$root='%ROOT%'; $n=0; Get-CimInstance Win32_Process | Where-Object { ($_.Name -in 'node.exe','ffmpeg.exe','ffprobe.exe','python.exe') -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($root.ToLower()) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; Write-Host ('    종료한 프로세스: ' + $n + '개')"

echo [4] 포트 %PORT% 정리 (이 앱이 점유한 경우만)...
powershell -NoProfile -NonInteractive -Command ^
  "$root='%ROOT%'; $n=0; $pids = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; foreach($p in $pids){ $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p); if($proc -and $proc.Name -eq 'node.exe'){ Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; $n++ } }; Write-Host ('    포트 정리: ' + $n + '개')"

echo [5] 이 앱의 브라우저 창 닫기 (창 제목에 앱 이름이 있는 창만)...
powershell -NoProfile -NonInteractive -Command ^
  "$n=0; foreach($p in Get-Process | Where-Object { $_.MainWindowTitle -like '*플레이리스트 팩토리*' -and $_.ProcessName -ne 'cmd' -and $_.ProcessName -ne 'powershell' }){ $null=$p.CloseMainWindow(); $n++ }; Write-Host ('    닫기 요청: ' + $n + '개 창')"

echo [6] 이 프로젝트의 명령 창 닫기 (명령줄에 프로젝트 경로가 포함된 cmd 만, 이 창 제외)...
powershell -NoProfile -NonInteractive -Command ^
  "$root='%ROOT%'; $me=(Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId; $n=0; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.ProcessId -ne $me -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($root.ToLower()) -and $_.CommandLine -notlike '*STOP.bat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; Write-Host ('    닫은 명령 창: ' + $n + '개')"

echo.
echo 정리가 끝났습니다. 이 창은 3초 후 닫힙니다.
timeout /t 3 >nul
exit
