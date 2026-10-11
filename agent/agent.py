#!/usr/bin/env python3
"""Агент ComputeCollateral: раз в N секунд отправляет в банк состояние GPU сервера.

    python agent.py --server http://bank-host:8765 --key CC-7F2K-91QX --name srv-01
    python agent.py ... --mock          # без GPU: синтетические данные для проверки

Использует только стандартную библиотеку. Данные: серийный номер, температура, загрузка, наработка.
Наработка (nvidia-smi её не отдаёт) накапливается агентом в локальном файле счётчика.
"""
import argparse
import json
import random
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

QUERY = "index,serial,temperature.gpu,utilization.gpu"


def read_nvidia_smi():
    if not shutil.which("nvidia-smi"):
        raise SystemExit("nvidia-smi не найден. Запустите агент на сервере с драйвером NVIDIA или используйте --mock")
    out = subprocess.run(["nvidia-smi", f"--query-gpu={QUERY}", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, check=True, timeout=30).stdout
    gpus = []
    for line in out.strip().splitlines():
        idx, serial, temp, util = [x.strip() for x in line.split(",")]
        gpus.append(dict(index=int(idx), serial=serial, temperature=float(temp), utilization=float(util)))
    return gpus


def read_mock(state):
    rng = random.Random(state.get("seed", 1))
    return [dict(index=i, serial=str(state.get("serial_base", 1654023118421) + i), temperature=60 + rng.randint(0, 8),
                 utilization=80 + rng.randint(0, 12)) for i in range(state.get("cards", 8))]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="адрес ComputeCollateral, например http://127.0.0.1:8765")
    ap.add_argument("--key", "--token", dest="key", required=True, help="ключ подключения из мастера «Новая оценка», вида CC-7F2K-91QX")
    ap.add_argument("--name", required=True, help="имя сервера из перечня оборудования (srv-01)")
    ap.add_argument("--interval", type=int, default=300, help="период отправки, сек (по ТЗ — раз в 5 минут)")
    ap.add_argument("--initial-hours", type=float, default=0, help="начальная наработка карт, ч")
    ap.add_argument("--once", action="store_true", help="отправить один раз и выйти")
    ap.add_argument("--mock", action="store_true", help="синтетические данные (без GPU)")
    ap.add_argument("--serial-base", type=int, default=1654023118421, help="для --mock: серийный номер GPU 0")
    ap.add_argument("--cards", type=int, default=8, help="для --mock: число карт")
    a = ap.parse_args()

    counter = Path.home() / f".cc_agent_hours_{a.name}"
    hours = float(counter.read_text()) if counter.exists() else a.initial_hours
    last = time.time()
    while True:
        gpus = read_mock(dict(serial_base=a.serial_base, cards=a.cards, seed=a.name)) if a.mock else read_nvidia_smi()
        now = time.time()
        hours += (now - last) / 3600
        last = now
        counter.write_text(str(hours))
        for g in gpus:
            g["hours"] = round(hours)
        body = json.dumps(dict(key=a.key, server=a.name, gpus=gpus)).encode()
        req = urllib.request.Request(a.server.rstrip("/") + "/api/agent/ingest", data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                print(time.strftime("%H:%M:%S"), "отправлено", len(gpus), "карт, ответ", r.status)
        except urllib.error.HTTPError as e:
            print("Ошибка сервера:", e.code, e.read().decode("utf-8", "replace")[:200], file=sys.stderr)
        except urllib.error.URLError as e:
            print("Нет связи с банком, повтор позже:", e.reason, file=sys.stderr)
        if a.once:
            return
        time.sleep(a.interval)


if __name__ == "__main__":
    main()
