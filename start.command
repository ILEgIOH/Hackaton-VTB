#!/bin/bash
cd "$(dirname "$0")"
command -v python3 >/dev/null || { echo "Установите Python 3.10+ (python.org)"; read -r; exit 1; }
[ -d .venv ] || { echo "Первый запуск: устанавливаю зависимости..."; python3 -m venv .venv; }
source .venv/bin/activate
pip install -q -r requirements.txt || pip install -q openpyxl reportlab python-docx
python run.py "$@"
