"""Исходящая почта: письма складываются в журнал (outbox); если заданы CC_SMTP_*, уходят по SMTP."""
from __future__ import annotations

import os
import smtplib
import time
from email.message import EmailMessage


def send(db: dict, to: str, subject: str, body: str, sender: str, kind: str = "manual", deal_id: str | None = None) -> dict:
    rec = dict(id=f"m{len(db.setdefault('outbox', [])) + 1}", ts=time.time(), to=to, sender=sender, subject=subject, body=body,
               kind=kind, deal_id=deal_id, status="queued")
    host = os.environ.get("CC_SMTP_HOST")
    if host:
        msg = EmailMessage()
        msg["From"], msg["To"], msg["Subject"] = os.environ.get("CC_SMTP_FROM", sender), to, subject
        msg.set_content(body)
        try:
            with smtplib.SMTP(host, int(os.environ.get("CC_SMTP_PORT", "587")), timeout=15) as s:
                if os.environ.get("CC_SMTP_TLS", "1") == "1":
                    s.starttls()
                if os.environ.get("CC_SMTP_USER"):
                    s.login(os.environ["CC_SMTP_USER"], os.environ.get("CC_SMTP_PASSWORD", ""))
                s.send_message(msg)
            rec["status"] = "sent"
        except Exception as e:  # письмо остаётся в журнале, ошибку видит сотрудник
            rec["status"] = "failed"
            rec["error"] = str(e)
            db["outbox"].append(rec)
            raise RuntimeError("Не удалось отправить письмо: " + str(e)) from None
    else:
        rec["status"] = "logged"   # SMTP не настроен: письмо сохранено в журнале (data/db.json → outbox)
    db["outbox"].append(rec)
    return rec
