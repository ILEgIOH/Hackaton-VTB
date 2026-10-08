"""Собирает автономную демо-версию в один файл demo/dist/index.html (без сервера, всё считается в браузере)."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
css = (root / "web/style.css").read_text("utf-8")
app = (root / "web/app.js").read_text("utf-8")
demo = (root / "demo/demo.js").read_text("utf-8")
for name, src in (("app.js", app), ("demo.js", demo)):
    assert "</script" not in src.lower(), name
html = f"""<title>ComputeCollateral</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>{css}</style>
<div id="app"></div><div id="toast" role="status"></div>
<script>{demo}</script>
<script>{app}</script>
"""
out = root / "demo/dist"
out.mkdir(exist_ok=True)
(out / "index.html").write_text(html, "utf-8")
print("built", out / "index.html", len(html) // 1024, "KB")
