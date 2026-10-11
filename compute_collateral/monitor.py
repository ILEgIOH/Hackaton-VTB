"""Фоновый мониторинг: симуляция телеметрии демо-агентов, правила уведомлений, периодический ИИ-анализ."""
from __future__ import annotations

import random
import threading
import time

from . import ai, alerts, engine


def drift(deal: dict, rng: random.Random, now: float, dt: float):
    for s in deal["servers"]:
        if s.get("frozen"):
            continue
        s["last_seen"] = now
        for g in s["gpus"]:
            if g.get("temp") is None:
                continue
            if g.get("hot"):
                g["temp"] = min(95, g["temp"] + rng.choice((0, 1)))
                continue
            g["temp"] = max(55, min(78, g["temp"] + rng.choice((-1, 0, 0, 1))))
            g["util"] = max(40, min(99, g["util"] + rng.choice((-2, -1, 0, 1, 2))))
            g["hours"] = (g.get("hours") or 0) + dt / 3600


class Monitor(threading.Thread):
    def __init__(self, store, tick: float = 15.0, app=None):
        super().__init__(daemon=True, name="cc-monitor")
        self.store, self.tick, self.rng, self.app = store, tick, random.Random(), app
        self.stop_event = threading.Event()

    def run(self):
        while not self.stop_event.wait(self.tick):
            try:
                self.step()
            except Exception as e:  # монитор не должен падать
                print("monitor error:", e)

    def step(self, now: float | None = None):
        now = now or time.time()
        st = self.store
        with st.lock:
            db = st.db
            cfg = ai.ai_config(db["settings"])
            changed = False
            if self.app:
                self.app.ensure_market_fresh()
                self.app.finalize_calcs(now)
            for deal in db["deals"].values():
                if deal.get("status") != "active":
                    continue
                if db["settings"].get("simulate", True) and deal.get("simulated"):
                    drift(deal, self.rng, now, self.tick)
                    changed = True
                if alerts.sync(db, deal, now):
                    changed = True
                if ai.ai_ready(cfg):
                    last = db["ai_reports"].get(deal["id"], {}).get("ts", 0)
                    if now - last >= cfg.get("interval_min", 30) * 60:
                        rep = ai.analyze(deal, engine.deal_detail(deal, now), cfg, now)
                        db["ai_reports"][deal["id"]] = rep
                        changed = True
            if changed:
                st.save()
