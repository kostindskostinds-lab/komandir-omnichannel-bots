@echo off
REM Запускает мост Telegram -> MAX и перезапускает его, если он упадёт.
REM Положите этот файл в ту же папку, что и telegram_to_max_bridge.py.

cd /d "%~dp0"

:loop
echo [%date% %time%] Запуск моста ABCP -> MAX...
python telegram_to_max_bridge.py
echo [%date% %time%] Скрипт остановился, перезапуск через 15 секунд...
timeout /t 15 /nobreak >nul
goto loop
