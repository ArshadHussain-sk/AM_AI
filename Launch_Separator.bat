@echo off
title AI Music Separator Launcher
echo ===================================================
echo   AI Vocal ^& Instrument Separator Launcher
echo ===================================================
echo Checking server status...

REM Check if port 8000 is already active
netstat -ano | findstr 127.0.0.1:8000 | findstr LISTENING >nul
if %ERRORLEVEL% EQU 0 (
    echo Server is already running. Opening browser...
    start http://127.0.0.1:8000
    exit /b
)

echo Starting FastAPI server in the background...
cd /d "d:\AM_AI"

REM Run python script in minimized console window
start "AI_Separator_Server" /min ".\venv\Scripts\python.exe" app.py

echo Waiting for the server to initialize (usually takes 3-5 seconds)...
:loop
netstat -ano | findstr 127.0.0.1:8000 | findstr LISTENING >nul
if %ERRORLEVEL% NEQ 0 (
    timeout /t 1 /nobreak >nul
    goto loop
)

echo Server is now live! Launching web interface...
start http://127.0.0.1:8000
exit
