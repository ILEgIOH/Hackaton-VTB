"""Замеры производительности ComputeCollateral (воспроизводимые цифры для презентации).

    python tools/bench.py                 # всё: движок оценки, приём телеметрии, задержка сигнала о подмене
    python tools/bench.py --seconds 10    # дольше гонять приём телеметрии

Поднимает сервис на демо-данных во временной папке, шлёт подписанные пакеты агента (как agent/agent.py)
в несколько потоков и считает пакетов в секунду. Сравнивает запись состояния «на каждый пакет» и отложенную запись.
"""
from __future__ import annotations

import argparse
import json
import platform
import statistics
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from compute_collateral import engine, security, seed  # noqa: E402
from compute_collateral.journal import Journal  # noqa: E402
from compute_collateral.server import create_server  # noqa: E402
from compute_collateral.store import Store  # noqa: E402


def start(tmp: Path, write_delay: float):
    import compute_collateral.server as srvmod
    import compute_collateral.store as stmod
    stmod.DATA_DIR = srvmod.DATA_DIR = tmp
    store = Store(tmp / "db.json", write_delay=write_delay, journal=Journal(tmp / "journal.sqlite"))
    seed.seed(store)
    srv = create_server(store, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, store


def packet(deal, srv_idx=0):
    s = deal["servers"][srv_idx % len(deal["servers"])]
    gpus = [dict(index=g["idx"], serial=g["serial"], temperature=66, utilization=88, hours=7000) for g in s["gpus"]]
    return s["name"], gpus


def send(port, key, server, gpus):
    body = json.dumps(dict(server=server, gpus=gpus)).encode()
    ts = f"{time.time():.6f}"
    hdr = {"Content-Type": "application/json", "X-CC-Key-Id": security.key_id(key), "X-CC-Timestamp": ts,
           "X-CC-Signature": security.sign(key, ts, body)}
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/agent/ingest", data=body, headers=hdr)
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def ingest_rate(write_delay: float, seconds: float, threads: int) -> float:
    with tempfile.TemporaryDirectory() as d:
        srv, store = start(Path(d), write_delay)
        deal = store.db["deals"]["neurocluster"]
        port, key = srv.server_address[1], deal["agent_key"]
        count, errors, stop = [0], [0], time.time() + seconds
        lock = threading.Lock()

        def worker(i):
            n = err = 0
            while time.time() < stop:
                name, gpus = packet(deal, i + n + err)
                try:
                    send(port, key, name, gpus)
                    n += 1
                except OSError:
                    err += 1
            with lock:
                count[0] += n
                errors[0] += err
        ts = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
        t0 = time.time()
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        rate = count[0] / (time.time() - t0)
        store.write_delay = 0
        store.flush()
        srv.shutdown()
        if errors[0]:
            print(f"    (ошибок соединения: {errors[0]})")
        return rate


def swap_latency(runs=20) -> float:
    """От прихода пакета с чужим серийным номером до появления уведомления о подмене (мс, медиана)."""
    with tempfile.TemporaryDirectory() as d:
        srv, store = start(Path(d), 0.5)
        deal = store.db["deals"]["datafork"]
        port, key = srv.server_address[1], deal["agent_key"]
        out = []
        for i in range(runs):
            name, gpus = packet(deal, 0)
            gpus[0]["serial"] = str(1700000000000 + i)
            t0 = time.perf_counter()
            send(port, key, name, gpus)
            hit = any(n["deal_id"] == "datafork" and n["kind"] == "swap" and n["status"] not in ("closed", "decided")
                      for n in store.db["notifications"])
            out.append((time.perf_counter() - t0) * 1000)
            if not hit:
                raise SystemExit("уведомление о подмене не появилось")
            for n in store.db["notifications"]:
                if n["deal_id"] == "datafork" and n["kind"] == "swap":
                    n["status"] = "closed"
        store.write_delay = 0
        store.flush()
        srv.shutdown()
        return statistics.median(out)


def engine_ms(cards: int, runs=200) -> float:
    from tests.test_all import make_deal
    d = make_deal(n=cards)
    t0 = time.perf_counter()
    for _ in range(runs):
        v = engine.valuation(d)
        engine.recommend_ltv(engine.forecast(d, val=v), v["market"])
    return (time.perf_counter() - t0) / runs * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=5)
    ap.add_argument("--threads", type=int, default=8)
    a = ap.parse_args()
    print(f"ComputeCollateral bench · Python {platform.python_version()} · {platform.machine()} · {platform.system()}")
    for n in (32, 512):
        print(f"  движок оценки, {n} GPU: {engine_ms(n):.2f} мс на полный расчёт (оценка + прогноз + LTV)")
    print(f"  сигнал о подмене: {swap_latency():.1f} мс (медиана, от пакета агента до уведомления)")
    r0 = ingest_rate(0, a.seconds, a.threads)
    r1 = ingest_rate(0.5, a.seconds, a.threads)
    print(f"  приём телеметрии, запись на каждый пакет: {r0:.0f} пакетов/с ≈ {r0 * 60:,.0f} серверов при отправке раз в минуту")
    print(f"  приём телеметрии, отложенная запись:      {r1:.0f} пакетов/с ≈ {r1 * 60:,.0f} серверов (раз в минуту),"
          f" {r1 * 300:,.0f} (раз в 5 минут)")
    print(f"  ускорение: ×{r1 / r0:.1f}")


if __name__ == "__main__":
    main()
