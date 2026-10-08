"""Запуск ComputeCollateral: python run.py [--port 8765] [--browser] [--reset]"""
import argparse
import sys
import threading
import webbrowser

from compute_collateral import alerts, monitor, seed
from compute_collateral.server import create_server
from compute_collateral.store import Store


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--browser", action="store_true", help="открыть в браузере вместо окна приложения")
    ap.add_argument("--no-window", action="store_true", help="только сервер (без окна и браузера)")
    ap.add_argument("--reset", action="store_true", help="пересоздать демо-данные")
    a = ap.parse_args()

    store = Store()
    if a.reset or not store.load():
        seed.seed(store)
    with store.lock:
        for d in store.db["deals"].values():
            alerts.sync(store.db, d)
    store.save()

    srv = create_server(store, a.host, a.port)
    monitor.Monitor(store).start()
    url = f"http://{a.host}:{a.port}/"
    print(f"ComputeCollateral: {url}  (вход: e.sokolova@bank.ru / Compute2026)")
    if a.no_window:
        srv.serve_forever()
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        if a.browser:
            raise ImportError
        import webview  # pip install pywebview
        webview.create_window("ComputeCollateral", url, width=1360, height=900, min_size=(1000, 700))
        webview.start()
    except ImportError:
        webbrowser.open(url)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            sys.exit(0)


if __name__ == "__main__":
    main()
