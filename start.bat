@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul || (echo Установите Python 3.10+ с python.org ^(галочка "Add to PATH"^) и запустите снова. & pause & exit /b 1)
if not exist .venv ( echo Первый запуск: устанавливаю зависимости... & python -m venv .venv )
call .venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt || python -m pip install -q openpyxl reportlab python-docx anthropic
python run.py %*
pause
