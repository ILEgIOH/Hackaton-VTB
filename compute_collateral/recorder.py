"""Запись настоящих ответов нейросети для автономного демо: анализ каждой сделки, вопросы к ИИ и сценарии инцидентов."""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path

from . import ai, engine

ROOT = Path(__file__).resolve().parent.parent
QUESTIONS = [
    "Какие серверы вызывают наибольшие опасения и почему?",
    "Что банку делать в первую очередь?",
    "Что будет с покрытием долга через год?",
]
INCIDENT_DEAL = "neurocluster"
INCIDENTS = ("overheat", "swap", "offline")


def _clean(rep: dict) -> dict:
    return {k: v for k, v in rep.items() if k in ("risk", "summary", "findings", "recommendations", "source", "model", "ai_error")}


def record(deals: dict, cfg: dict, apply_incident, progress=None, now: float | None = None) -> dict:
    """Возвращает словарь с ответами. Реальные сделки не меняются: инциденты применяются к копии."""
    now = now or time.time()
    out = dict(model=cfg["model"], recorded_at=now, questions=QUESTIONS, deals={}, incidents={})
    live = [d for d in deals.values() if d.get("status") != "draft"]
    total = len(live) * (1 + len(QUESTIONS)) + len(INCIDENTS)
    done = 0

    def tick():
        nonlocal done
        done += 1
        if progress:
            progress(done, total)

    def analyze(deal):
        rep = ai.analyze(deal, engine.deal_detail(deal, now), cfg, now)
        if rep.get("source") != "ai":
            raise RuntimeError(rep.get("ai_error") or "Нейросеть не ответила")
        return _clean(rep)

    for d in live:
        det = engine.deal_detail(d, now)
        entry = dict(report=analyze(d), chat={})
        tick()
        for q in QUESTIONS:
            entry["chat"][q] = ai.ask(d, det, cfg, q, now)
            tick()
        out["deals"][d["id"]] = entry
    base = deals.get(INCIDENT_DEAL)
    if base:
        for kind in INCIDENTS:
            c = copy.deepcopy(base)
            apply_incident(c, kind)
            out["incidents"].setdefault(INCIDENT_DEAL, {})[kind] = analyze(c)
            tick()
    return out


def save(data: dict) -> Path:
    p = ROOT / "docs" / "ai_recordings.json"
    p.parent.mkdir(exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    return p
