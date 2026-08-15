@echo off
title Stop AI Music Separator
echo ===================================================
echo   Stopping AI Vocal ^& Instrument Separator...
echo ===================================================

REM Find PID listening on port 8000 and terminate it
set "pid="
for /f "tokens=5" %%a in ('netstat -aon ^| findstr 127.0.0.1:8000 ^| findstr LISTENING') do set "pid=%%a"

if defined pid (
    echo Found active server process with PID %pid%. Terminating...
    taskkill /f /pid %pid%
    echo Server has been stopped successfully.
) else (
    echo No active server found on port 8000. It is already offline.
)

timeout /t 3 >nul
exit
