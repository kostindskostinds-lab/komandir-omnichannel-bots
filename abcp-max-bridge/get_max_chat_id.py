"""
Вспомогательный скрипт: помогает узнать chat_id группового чата MAX.

Как пользоваться:
1. Впишите ниже MAX_BOT_TOKEN (токен, выданный при создании бота в MAX для партнёров).
2. Запустите этот скрипт: python get_max_chat_id.py
3. Пока скрипт работает, добавьте бота в нужный групповой чат MAX
   (или напишите боту в личку, если нужен личный chat_id).
4. Скрипт поймает событие bot_added / message_created и напечатает chat_id.
   Скопируйте это число в config.json -> max_target_chat_id.
5. Остановите скрипт (Ctrl+C).
"""

import json
import sys
import time
import urllib.request
import urllib.error

MAX_API_BASE = "https://platform-api2.max.ru"

# Впишите токен сюда ИЛИ передайте первым аргументом командной строки:
#   python get_max_chat_id.py ВАШ_ТОКЕН
MAX_BOT_TOKEN = "your_max_bot_access_token_here"


def call_max_api(method: str, path: str, token: str, params: dict | None = None, body: dict | None = None):
    url = f"{MAX_API_BASE}{path}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        if query:
            url = f"{url}?{query}"

    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", token)
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=100) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code} ошибка от MAX API: {e.read().decode('utf-8', 'ignore')}")
        return None
    except Exception as e:
        print(f"Ошибка запроса к MAX API: {e}")
        return None


def main():
    token = sys.argv[1] if len(sys.argv) > 1 else MAX_BOT_TOKEN
    if not token or token == "your_max_bot_access_token_here":
        print("Впишите токен MAX-бота в переменную MAX_BOT_TOKEN или передайте его аргументом.")
        sys.exit(1)

    print("Жду события от MAX (добавление бота в чат / входящее сообщение)...")
    print("Сейчас добавьте бота в нужный групповой чат MAX (или напишите ему в личку).")
    marker = None

    while True:
        result = call_max_api(
            "GET",
            "/updates",
            token,
            params={"timeout": 30, "limit": 100, "marker": marker},
        )
        if not result:
            time.sleep(2)
            continue

        for update in result.get("updates", []):
            utype = update.get("type")
            payload = update.get("payload", {})
            print(f"\n--- Получено событие: {utype} ---")
            print(json.dumps(update, ensure_ascii=False, indent=2))

            chat_id = payload.get("chat_id") or payload.get("chat", {}).get("chat_id")
            if chat_id:
                print(f"\n>>> НАЙДЕН chat_id: {chat_id}")
                print(">>> Скопируйте это значение в config.json -> max_target_chat_id\n")

        marker = result.get("marker", marker)


if __name__ == "__main__":
    main()
