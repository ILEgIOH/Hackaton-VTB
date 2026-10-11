"""ИИ-наблюдатель за серверами: правила + (опционально) любая LLM с OpenAI-совместимым API."""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import date

from . import engine

SEV_ORDER = {"info": 0, "warning": 1, "critical": 2}
RISK_BY_SEV = {0: "low", 1: "medium", 2: "high"}

SYSTEM_PROMPT = """Ты — аналитик банка, который следит за состоянием GPU-серверов, переданных в залог по кредиту.
Тебе дают JSON-снимок телеметрии (температура, загрузка, наработка, совпадение серийных номеров, связь) и параметры кредита.
Найди аномалии и риски для залога: подмена или вывод карт, перегрев, простой, нереалистичная наработка, потеря связи,
угроза нарушения ковенанта покрытия. Не выдумывай данных, которых нет в снимке.
Ответь СТРОГО одним JSON-объектом без пояснений вокруг:
{"risk":"low|medium|high","summary":"1-2 предложения по-русски",
 "findings":[{"severity":"info|warning|critical","title":"...","detail":"...","server":"srv-01|null","gpu":0|null}],
 "recommendations":["..."]}"""


def ai_config(db_settings: dict) -> dict:
    cfg = dict(db_settings.get("ai", {}))
    cfg["base_url"] = os.environ.get("CC_AI_BASE_URL", cfg.get("base_url") or "https://api.openai.com/v1")
    cfg["api_key"] = os.environ.get("CC_AI_API_KEY", cfg.get("api_key") or "")
    cfg["model"] = os.environ.get("CC_AI_MODEL", cfg.get("model") or "gpt-4o-mini")
    return cfg


def ai_ready(cfg: dict) -> bool:
    # локальные модели (Ollama, vLLM) могут работать без ключа
    local = any(h in cfg["base_url"] for h in ("localhost", "127.0.0.1"))
    return bool(cfg.get("enabled")) and (bool(cfg["api_key"]) or local)


def chat(cfg: dict, messages: list[dict], json_mode: bool = False, timeout: int = 60) -> str:
    body = dict(model=cfg["model"], messages=messages, temperature=0.2)
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    headers = {"Content-Type": "application/json"}
    if cfg["api_key"]:
        headers["Authorization"] = f"Bearer {cfg['api_key']}"
    req = urllib.request.Request(cfg["base_url"].rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        if json_mode and e.code == 400:  # не все серверы знают response_format
            return chat(cfg, messages, json_mode=False, timeout=timeout)
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Нет связи с API: {e.reason}") from None
    return data["choices"][0]["message"]["content"]


def extract_json(text: str) -> dict:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if not m:
            raise ValueError("Модель вернула не JSON")
        return json.loads(m.group(0))


# ---------- снимок и правила ----------

def snapshot(deal: dict, detail: dict, now: float) -> dict:
    return dict(
        borrower=deal["borrower"], contract=deal.get("contract"), telemetry_mode=deal.get("telemetry_mode"),
        loan=dict(amount=deal["loan"]["amount"], term_months=deal["loan"]["term"], rate=deal["loan"]["rate"],
                  covenant=deal["loan"].get("covenant", 1.25)),
        market_value=round(detail["valuation"]["market"]), debt=round(detail["debt_now"]),
        coverage=round(detail["coverage_now"] or 0, 3),
        servers=[dict(
            name=s["name"], model=s["model"], online=engine.is_online(s, now) if deal.get("telemetry_mode") == "agent" else None,
            minutes_since_seen=round((now - s["last_seen"]) / 60) if s.get("last_seen") else None,
            gpus=[dict(idx=g["idx"], serial_contract=g["serial"], serial_actual=g.get("actual_serial"),
                       temp=g.get("temp"), util=g.get("util"), hours=g.get("hours"),
                       commissioned=g.get("commissioned")) for g in s["gpus"]],
        ) for s in deal["servers"]],
    )


def _c(v):
    return f"{v:.2f}".replace(".", ",")


def _d(iso):
    return f"{iso[8:10]}.{iso[5:7]}.{iso[:4]}"


def rule_findings(deal: dict, detail: dict, now: float) -> list[dict]:
    f = []
    today = date.today()
    for m in detail["equipment"]["mismatches"]:
        f.append(dict(severity="critical", title="Серийный номер не совпадает с договором", server=m["server"], gpu=m["gpu"],
                      detail=f"По договору {m['contract']}, установлен {m['actual']}. Возможна подмена карты."))
    for s in deal["servers"]:
        if deal.get("telemetry_mode") == "agent" and not engine.is_online(s, now):
            mins = round((now - (s.get("last_seen") or 0)) / 60)
            f.append(dict(severity="critical" if mins > 60 else "warning", title="Нет связи с сервером", server=s["name"], gpu=None,
                          detail=f"Последние данные {mins} мин назад."))
        for g in s["gpus"]:
            t, u, h = g.get("temp"), g.get("util"), g.get("hours")
            if t is not None and t >= 85:
                f.append(dict(severity="critical", title="Критический перегрев", server=s["name"], gpu=g["idx"],
                              detail=f"{t} °C — риск ускоренного износа."))
            elif t is not None and t >= 80:
                f.append(dict(severity="warning", title="Повышенная температура", server=s["name"], gpu=g["idx"], detail=f"{t} °C."))
            if h and g.get("commissioned"):
                age_h = (today - date.fromisoformat(g["commissioned"])).days * 24
                if h > age_h * 1.02 + 24:
                    f.append(dict(severity="critical", title="Наработка больше возраста карты", server=s["name"], gpu=g["idx"],
                                  detail=f"{h} ч при возрасте {age_h} ч — данные недостоверны или карту заменили."))
                elif age_h > 2000 and h < age_h * 0.05:
                    f.append(dict(severity="warning", title="Подозрительно малая наработка", server=s["name"], gpu=g["idx"],
                                  detail=f"{h} ч при возрасте {age_h} ч — возможна замена карты."))
    for s in deal["servers"]:
        utils = [g["util"] for g in s["gpus"] if g.get("util") is not None]
        if utils and sum(utils) / len(utils) < 5 and engine.is_online(s, now):
            f.append(dict(severity="warning", title="Сервер простаивает", server=s["name"], gpu=None,
                          detail="Средняя загрузка карт ниже 5 % — оборудование не приносит дохода."))
    cov = detail["coverage_now"]
    covenant = detail["forecast"]["covenant"]
    if cov is not None and cov < covenant:
        f.append(dict(severity="critical", title="Нарушение ковенанта покрытия", server=None, gpu=None,
                      detail=f"Покрытие {_c(cov)} ниже ковенанта {_c(covenant)}."))
    elif detail["status"] == "near":
        f.append(dict(severity="warning", title="Покрытие близко к порогу", server=None, gpu=None,
                      detail=f"Покрытие {_c(cov)} при ковенанте {_c(covenant)}."))
    if detail["gap"]:
        g = detail["gap"]
        f.append(dict(severity="warning", title="Прогноз: залог может стать дешевле долга", server=None, gpu=None,
                      detail=f"В пессимистичном сценарии с {_d(g['first_date'])}, разрыв до {g['max_gap'] / 1e6:.1f} млн ₽".replace(".", ",") + "."))
    return f


def rules_report(deal: dict, detail: dict, now: float) -> dict:
    findings = rule_findings(deal, detail, now)
    top = max((SEV_ORDER[x["severity"]] for x in findings), default=0)
    recs = []
    if any(x["title"].startswith("Серийный") for x in findings):
        recs.append("Назначить выездную проверку и приостановить выдачу траншей")
    if any("ковенант" in x["title"].lower() for x in findings):
        recs.append("Запросить дополнительное обеспечение или назначить переоценку")
    if any("перегрев" in x["title"].lower() or "температур" in x["title"].lower() for x in findings):
        recs.append("Запросить у заёмщика отчёт об охлаждении и обслуживании")
    if any("связи" in x["title"] for x in findings):
        recs.append("Связаться с заёмщиком и уточнить причину отсутствия телеметрии")
    summary = (f"Найдено замечаний: {len(findings)}." if findings else "Аномалий не обнаружено, залог в норме.")
    return dict(risk=RISK_BY_SEV[top], summary=summary, findings=findings, recommendations=recs,
                source="rules", ts=now)


def analyze(deal: dict, detail: dict, cfg: dict, now: float | None = None) -> dict:
    now = now or time.time()
    base = rules_report(deal, detail, now)
    if not ai_ready(cfg):
        return base
    snap = snapshot(deal, detail, now)
    user = ("Снимок телеметрии:\n" + json.dumps(snap, ensure_ascii=False) +
            "\n\nЗамечания, найденные детерминированными правилами:\n" + json.dumps(base["findings"], ensure_ascii=False))
    try:
        out = extract_json(chat(cfg, [dict(role="system", content=SYSTEM_PROMPT), dict(role="user", content=user)], json_mode=True))
        findings = [x for x in out.get("findings", []) if isinstance(x, dict) and x.get("title")]
        for x in findings:
            x["severity"] = x.get("severity") if x.get("severity") in SEV_ORDER else "info"
        risk = out.get("risk") if out.get("risk") in ("low", "medium", "high") else base["risk"]
        # ИИ не вправе занижать риск, найденный жёсткими правилами
        if RISK_BY_SEV and ("low", "medium", "high").index(risk) < ("low", "medium", "high").index(base["risk"]):
            risk = base["risk"]
        return dict(risk=risk, summary=str(out.get("summary", base["summary"])), findings=findings or base["findings"],
                    recommendations=[str(r) for r in out.get("recommendations", [])] or base["recommendations"],
                    source="ai", model=cfg["model"], ts=now, rules=base["findings"])
    except Exception as e:  # сеть/формат — откатываемся на правила
        base["ai_error"] = str(e)
        return base


def ask(deal: dict, detail: dict, cfg: dict, question: str, now: float | None = None) -> str:
    if not ai_ready(cfg):
        raise RuntimeError("ИИ не подключён: включите его в «Настройки → ИИ-наблюдатель» и укажите API-ключ")
    snap = snapshot(deal, detail, now or time.time())
    msgs = [dict(role="system", content="Ты — аналитик банка по залогу GPU-серверов. Отвечай по-русски, кратко и по делу, "
                 "опираясь только на переданные данные.\nДанные сделки:\n" + json.dumps(snap, ensure_ascii=False)),
            dict(role="user", content=question)]
    return chat(cfg, msgs)


def list_models(cfg: dict) -> list[str]:
    """GET {base_url}/models — список моделей провайдера для выпадающего списка в настройках."""
    headers = {"Authorization": f"Bearer {cfg['api_key']}"} if cfg["api_key"] else {}
    req = urllib.request.Request(cfg["base_url"].rstrip("/") + "/models", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Нет связи с API: {e.reason}") from None
    items = data.get("data") or data.get("models") or []
    return sorted(str(m.get("id") or m.get("name")) for m in items if isinstance(m, dict))
