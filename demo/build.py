"""Собирает автономную демо-версию в один файл demo/dist/index.html (без сервера, всё считается в браузере)."""
from pathlib import Path

root = Path(__file__).resolve().parent.parent
css = (root / "web/style.css").read_text("utf-8")
demo = (root / "demo/demo.js").read_text("utf-8")
parts = [("demo.js", demo)] + [(n, (root / "web/js" / n).read_text("utf-8")) for n in ("core.js", "auth.js", "portfolio.js", "wizard.js", "deal.js", "notif.js")]
for name, src in parts:
    assert "</script" not in src.lower(), name
scripts = "".join(f"<script>{src}</script>\n" for _, src in parts)
html = f"""<title>ComputeCollateral</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>{css}</style>
<div id="app"></div><div id="toast" role="status"></div>
{scripts}<script>route();</script>
"""
out = root / "demo/dist"
out.mkdir(exist_ok=True)
(out / "index.html").write_text(html, "utf-8")
print("built", out / "index.html", len(html) // 1024, "KB")
