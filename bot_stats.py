#!/usr/bin/env python3
"""Статистика по ботам komandir-nn (Telegram и MAX) из data/events.jsonl.

Запуск:  python bot_stats.py            - все время
         python bot_stats.py --days 7   - только последние 7 дней
         python bot_stats.py --bot max  - только один бот (telegram | max)

Старые записи data/stuck-log.jsonl (до появления events.jsonl) учитываются как
события "fail", если они раньше первого события в events.jsonl.
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BOTS = {
    "telegram": ROOT / "telegram-bot" / "data",
    "max": ROOT / "max-bot" / "data",
}
# Порядок шагов для воронки (совпадает в обоих ботах).
FUNNEL = [
    "welcome", "welcome_registered", "registered_later", "reg_1", "reg_2", "reg_3", "reg_4", "reg_5", "reg_6", "reg_7",
    "order_login", "search_1", "search_2", "cart_1", "cart_2",
    "checkout_1", "checkout_2", "checkout_guest", "checkout_3", "checkout_4", "done",
]


def read_jsonl(path):
    out = []
    if not path.exists():
        return out
    with path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # битая/недописанная строка - пропускаем
    return out


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load(bot, since):
    data_dir = BOTS[bot]
    events = read_jsonl(data_dir / "events.jsonl")
    first = min((parse_ts(e["ts"]) for e in events), default=None)
    legacy = 0
    for e in read_jsonl(data_dir / "stuck-log.jsonl"):
        if first is None or parse_ts(e["ts"]) < first:
            events.append({**e, "event": "fail", "legacy": True})
            legacy += 1
    if since:
        events = [e for e in events if parse_ts(e["ts"]) >= since]
    return events, legacy


def report(bot, events, legacy):
    print(f"\n{'=' * 60}\n{bot.upper()}\n{'=' * 60}")
    if not events:
        print("Событий нет.")
        return
    local = lambda e: parse_ts(e["ts"]).astimezone()
    users = {e["chatId"] for e in events if e.get("chatId") is not None}
    starters = {e["chatId"] for e in events if e["event"] == "start" and e.get("chatId") is not None}
    print(f"Период: {min(map(local, events)):%d.%m.%Y %H:%M} - {max(map(local, events)):%d.%m.%Y %H:%M}")
    print(f"Уникальных пользователей: {len(users)} (нажали Start: {len(starters)})")
    if legacy:
        print(f"  (в т.ч. {legacy} старых записей stuck-log.jsonl учтены как ❌)")

    per_day = defaultdict(set)
    for e in events:
        if e.get("chatId") is not None:
            per_day[local(e).date()].add(e["chatId"])
    print("Активных пользователей по дням: " + ", ".join(f"{d:%d.%m}: {len(u)}" for d, u in sorted(per_day.items())))

    c = Counter(e["event"] for e in events)
    print(f"\nСобытия: старт {c['start']}, шагов показано {c['step']}, ✅ {c['ok']}, ❌ {c['fail']}, "
          f"вызовов менеджера {c['manager_request']}, вопросов отправлено {c['manager_question']}")
    undelivered = sum(1 for e in events if e["event"] == "manager_question" and e.get("delivered") is False)
    if undelivered:
        print(f"  ! вопросов менеджеру НЕ доставлено: {undelivered}")
    with_phone = sum(1 for e in events if e["event"] == "manager_question" and e.get("hasPhone"))
    if c["manager_phone_shared"] or with_phone:
        print(f"  телефон поделились: {c['manager_phone_shared']}, дошло до менеджера с телефоном: {with_phone}")
    if c["manager_reply"]:
        avg_len = round(sum(e.get("length", 0) for e in events if e["event"] == "manager_reply") / c["manager_reply"])
        print(f"  ответов менеджера через «Ответить»: {c['manager_reply']} (средняя длина {avg_len} симв.)")

    reached = defaultdict(set)
    ok = Counter()
    fail = Counter()
    for e in events:
        sid = e.get("stepId")
        if e["event"] == "step" and sid:
            reached[sid].add(e["chatId"])
        elif e["event"] == "ok" and sid:
            ok[sid] += 1
        elif e["event"] == "fail" and sid:
            fail[sid] += 1
    if reached:
        print(f"\nВоронка (уникальных пользователей, дошедших до шага):")
        print(f"{'шаг':<16}{'дошли':>7}{'✅':>5}{'❌':>5}")
        for sid in FUNNEL + sorted(set(reached) - set(FUNNEL)):
            if sid in reached or fail[sid]:
                print(f"{sid:<16}{len(reached[sid]):>7}{ok[sid]:>5}{fail[sid]:>5}")
        done = len(reached.get("done", ()))
        print(f"\nДошли до конца сценария (done): {done} из {len(users)}")
    if fail:
        print("Больше всего ❌: " + ", ".join(f"{s} ({n})" for s, n in fail.most_common(3)))
    mg = Counter(e.get("stepId") or "(из меню)" for e in events if e["event"] == "manager_request")
    if mg:
        print("Вызовы менеджера по шагам: " + ", ".join(f"{s} ({n})" for s, n in mg.most_common()))


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, help="только последние N дней")
    ap.add_argument("--bot", choices=list(BOTS), help="только один бот")
    args = ap.parse_args()
    since = datetime.now(timezone.utc) - timedelta(days=args.days) if args.days else None
    for bot in ([args.bot] if args.bot else BOTS):
        events, legacy = load(bot, since)
        report(bot, events, legacy)


if __name__ == "__main__":
    main()
