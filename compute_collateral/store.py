"""Простое JSON-хранилище с блокировкой (достаточно для настольного приложения)."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path

DATA_DIR = Path(os.environ.get("CC_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(8)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()
    return f"{salt}${h}"


def check_password(password: str, stored: str) -> bool:
    salt, _ = stored.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt), stored)


class Store:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else DATA_DIR / "db.json"
        self.lock = threading.RLock()
        self.db: dict = {}
        self.sessions: dict[str, dict] = {}
        self.failures: dict[str, list] = {}      # почта -> [число ошибок, до какого времени вход закрыт]
        self.session_ttl = float(os.environ.get("CC_SESSION_MIN", "30")) * 60

    def load(self) -> bool:
        if self.path.exists():
            self.db = json.loads(self.path.read_text("utf-8"))
            return True
        return False

    def save(self):
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.db, ensure_ascii=False, indent=1), "utf-8")
            tmp.replace(self.path)

    # сессии живут в памяти — после перезапуска нужно войти заново; 30 минут без действий — сессия завершена
    def new_session(self, email: str) -> str:
        tok = secrets.token_urlsafe(24)
        self.sessions[tok] = dict(email=email, last=time.time())
        return tok

    def user_for(self, token: str | None):
        """-> (пользователь | None, сессия_истекла)"""
        s = self.sessions.get(token or "")
        if not s:
            return None, False
        if time.time() - s["last"] > self.session_ttl:
            self.sessions.pop(token, None)
            return None, True
        s["last"] = time.time()
        return next((u for u in self.db["users"] if u["email"] == s["email"]), None), False
