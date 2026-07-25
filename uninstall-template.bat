@echo off
chcp 65001 > nul
setlocal EnableDelayedExpansion
title Auxo 완전 삭제

set "APPDIR=%~dp0"
if "%APPDIR:~-1%"=="\" set "APPDIR=%APPDIR:~0,-1%"
set "DATADIR=%APPDATA%\Auxo"
set "OLDDATA=%APPDATA%\agentlink-app"

echo.
echo   ============================================================
echo     Auxo 완전 삭제
echo   ============================================================
echo.
echo   아래 항목을 모두 지웁니다. 되돌릴 수 없습니다.
echo.
echo     [1] 프로그램 폴더
echo         %APPDIR%
echo.
if exist "%DATADIR%" (
  echo     [2] 내 데이터 폴더  ^(대화 / 기억 / API 키 / 설정^)
  echo         %DATADIR%
) else (
  echo     [2] 내 데이터 폴더 — 없음 ^(이미 지워졌거나 실행한 적 없음^)
)
if exist "%OLDDATA%" (
  echo.
  echo     [3] 옛 버전 데이터 폴더
  echo         %OLDDATA%
)
echo.
echo   ------------------------------------------------------------
echo   주의: 에이전트와 나눈 대화, 쌓인 기억이 전부 사라집니다.
echo         남기고 싶다면 먼저 앱에서 [내보내기]를 해두세요.
echo   ------------------------------------------------------------
echo.
echo   ※ 함께 설치했던 claude / codex / agy 같은 프로그램은
echo      Auxo 것이 아니므로 지우지 않습니다.
echo.

set "ANSWER="
set /p "ANSWER=  정말 지우려면  DELETE  를 입력하세요 (취소: 그냥 Enter): "
if /i not "%ANSWER%"=="DELETE" (
  echo.
  echo   취소했습니다. 아무것도 지우지 않았습니다.
  echo.
  pause
  exit /b 0
)

echo.
echo   실행 중인 Auxo를 닫는 중...
taskkill /IM Auxo.exe /F > nul 2>&1
timeout /t 2 /nobreak > nul

echo   데이터 폴더를 지우는 중...
if exist "%DATADIR%" rd /s /q "%DATADIR%" 2>nul
if exist "%OLDDATA%" rd /s /q "%OLDDATA%" 2>nul

if exist "%DATADIR%" (
  echo.
  echo   [!] 데이터 폴더를 지우지 못했습니다. Auxo가 아직 켜져 있을 수 있어요.
  echo       모든 Auxo 창을 닫고 다시 실행해 주세요.
  echo       경로: %DATADIR%
  echo.
  pause
  exit /b 1
)

echo   프로그램 폴더를 지우는 중...

rem 자기 자신이 이 폴더 안에 있으므로, 임시 폴더의 도우미가 마지막에 지운다.
set "HELPER=%TEMP%\auxo-remove-%RANDOM%.bat"
> "%HELPER%" echo @echo off
>> "%HELPER%" echo chcp 65001 ^> nul
>> "%HELPER%" echo rem 지우려는 폴더를 현재 위치로 잡고 있으면 삭제가 실패한다. 먼저 벗어난다.
>> "%HELPER%" echo cd /d "%%TEMP%%"
>> "%HELPER%" echo timeout /t 2 /nobreak ^> nul
>> "%HELPER%" echo rd /s /q "%APPDIR%" 2^>nul
>> "%HELPER%" echo if exist "%APPDIR%" ^(
>> "%HELPER%" echo   echo.
>> "%HELPER%" echo   echo   [!] 프로그램 폴더를 지우지 못했습니다: %APPDIR%
>> "%HELPER%" echo   echo       폴더를 직접 삭제해 주세요.
>> "%HELPER%" echo   echo.
>> "%HELPER%" echo   pause
>> "%HELPER%" echo ^) else ^(
>> "%HELPER%" echo   echo.
>> "%HELPER%" echo   echo   Auxo가 완전히 삭제됐습니다. 그동안 감사했습니다.
>> "%HELPER%" echo   echo.
>> "%HELPER%" echo   timeout /t 4 /nobreak ^> nul
>> "%HELPER%" echo ^)
>> "%HELPER%" echo del "%%~f0" ^> nul 2^>^&1

echo.
echo   데이터 삭제 완료. 프로그램 폴더를 정리하고 창을 닫습니다.
echo.
start "" /min /d "%TEMP%" cmd /c "%HELPER%"
exit /b 0
