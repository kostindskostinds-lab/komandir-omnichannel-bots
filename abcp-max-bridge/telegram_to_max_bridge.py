"""
Мост Telegram -> MAX.

Слушает групповой чат Telegram, в который ABCP шлёт уведомления о новых
заказах, и пересылает каждое новое текстовое сообщение в групповой чат MAX.

Работает непрерывно (long polling с обеих сторон), рассчитан на запуск
как фоновый процесс на ПК, который обычно включён.

Требует: pip install requests
"""

import json
import logging
import time
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
STATE_PATH = BASE_DIR / "state.json"
LOG_PATH = BASE_DIR / "bridge.log"

TELEGRAM_API_BASE = "https://api.telegram.org"
MAX_API_BASE = "https://platform-api2.max.ru"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler()],
)
log = logging.getLogger("bridge")


def load_config():
    if not CONFIG_PATH.exists():
        raise SystemExit(
            f"Не найден {CONFIG_PATH}. Скопируйте config.example.json в config.json "
            "и заполните своими значениями."
        )
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_state():
    if STATE_PATH.exists():
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"telegram_offset": 0}


def save_state(state):
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f)


def get_telegram_updates(token: str, offset: int, timeout: int):
    url = f"{TELEGRAM_API_BASE}/bot{token}/getUpdates"
    params = {"offset": offset, "timeout": timeout, "allowed_updates": json.dumps(["message"])}
    try:
        resp = requests.get(url, params=params, timeout=timeout + 10)
        resp.raise_for_status()
        return resp.json().get("result", [])
    except requests.RequestException as e:
        log.warning("Ошибка опроса Telegram: %s", e)
        return []


def send_to_max(token: str, chat_id: int, text: str):
    url = f"{MAX_API_BASE}/messages"
    headers = {"Authorization": token, "Content-Type": "application/json"}
    params = {"chat_id": chat_id}
    body = {"text": text[:4000], "format": "markdown", "notify": True}
    try:
        resp = requests.post(url, headers=headers, params=params, json=body, timeout=30)
        if resp.status_code >= 400:
            log.error("MAX API вернул ошибку %s: %s", resp.status_code, resp.text)
            return False
        return True
    except requests.RequestException as e:
        log.error("Ошибка отправки в MAX: %s", e)
        return False


def main():
    config = load_config()
    state = load_state()

    tg_token = config["telegram_bot_token"]
    tg_source_chat_id = int(config["telegram_source_chat_id"])
    max_token = config["max_bot_token"]
    max_chat_id = int(config["max_target_chat_id"])
    poll_timeout = int(config.get("poll_timeout_seconds", 30))
    prefix = config.get("max_text_prefix", "")

    log.info("Мост запущен. Источник: Telegram chat_id=%s -> MAX chat_id=%s", tg_source_chat_id, max_chat_id)

    offset = state.get("telegram_offset", 0)

    while True:
        updates = get_telegram_updates(tg_token, offset, poll_timeout)

        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message")
            if not message:
                continue

            chat = message.get("chat", {})
            if chat.get("id") != tg_source_chat_id:
                continue

            text = message.get("text") or message.get("caption")
            if not text:
                continue

            log.info("Новое сообщение из ABCP-группы, пересылаю в MAX: %.80s", text)
            ok = send_to_max(max_token, max_chat_id, prefix + text)
            if not ok:
                log.warning("Не удалось переслать сообщение, попробую снова через минуту")
                time.sleep(60)
                send_to_max(max_token, max_chat_id, prefix + text)

        state["telegram_offset"] = offset
        save_state(state)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log.info("Остановлено пользователем.")
