#!/usr/bin/env python3
"""Read-only verification of the 03:00 KST ModelFlow backup and failure-only email alert.

No database, Docker, or backup deletion calls. Run at 04:00 KST via Cron.
Credentials live outside the Git checkout in ~/.config/model-flow/backup-alert.json.
"""
from __future__ import annotations

import argparse
from datetime import datetime, time, timedelta, timezone
from email.message import EmailMessage
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import stat
import sys
from zoneinfo import ZoneInfo

AUTO_NAME = re.compile(r"^auto-[0-9]{8}T[0-9]{6}Z-[0-9]+$")
STAMP_FORMAT = "%Y%m%dT%H%M%SZ"
KST = ZoneInfo("Asia/Seoul")
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_AUTO_ROOT = ROOT / "backups" / "auto"
DEFAULT_CONFIG = Path.home() / ".config" / "model-flow" / "backup-alert.json"


def read_stamp(raw: str) -> datetime:
    return datetime.strptime(raw, STAMP_FORMAT).replace(tzinfo=timezone.utc)


def inspect_health(auto_root: Path, now: datetime | None = None) -> str:
    """Return a stable failure code, or PASS, without reading backup payloads."""
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(timezone.utc)
    today_kst = now.astimezone(KST).date()
    scheduled = datetime.combine(today_kst, time(3, 0), KST).astimezone(timezone.utc)
    if now < scheduled + timedelta(minutes=10):
        return "BEFORE_VERIFICATION_WINDOW"
    if auto_root.is_symlink() or not auto_root.is_dir():
        return "BACKUP_DIRECTORY_MISSING"

    status_file = auto_root / "last-run.status"
    if status_file.is_symlink() or not status_file.is_file():
        return "STATUS_MISSING"
    try:
        if status_file.stat().st_size > 4096:
            return "STATUS_INVALID"
        lines = status_file.read_text(encoding="utf-8").splitlines()
        fields = {}
        for line in lines:
            if "=" not in line:
                return "STATUS_INVALID"
            key, value = line.split("=", 1)
            if key in fields:
                return "STATUS_INVALID"
            fields[key] = value
        if fields.get("status") != "SUCCESS" or fields.get("exit_code") != "0":
            return "LAST_RUN_FAILED"
        finished = read_stamp(fields["finished_at"])
    except (OSError, UnicodeError, ValueError, KeyError):
        return "STATUS_INVALID"

    if finished < scheduled or finished > now + timedelta(minutes=5):
        return "LAST_RUN_STALE"

    try:
        for candidate in auto_root.iterdir():
            if not AUTO_NAME.fullmatch(candidate.name):
                continue
            if candidate.is_symlink() or not candidate.is_dir():
                continue
            marker = candidate / "verified.ok"
            if marker.is_symlink() or not marker.is_file():
                continue
            if marker.stat().st_size > 1024:
                continue
            lines = marker.read_text(encoding="utf-8").splitlines()
            if len(lines) != 1 or not lines[0].startswith("verified_at="):
                continue
            verified = read_stamp(lines[0].removeprefix("verified_at="))
            if scheduled <= verified <= finished and finished - verified <= timedelta(minutes=5):
                return "PASS"
    except (OSError, UnicodeError, ValueError):
        return "VERIFIED_MARKER_INVALID"
    return "VERIFIED_MARKER_MISSING"


def load_mail_config(path: Path) -> dict:
    if path.is_symlink():
        raise ValueError("config symlink forbidden")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError("config must be a user-owned regular file")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("config must not be readable by group or others")
    if info.st_size > 8192:
        raise ValueError("config too large")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("invalid config")
    required = ("host", "port", "transport", "sender", "recipient")
    if any(not data.get(key) for key in required):
        raise ValueError("missing mail configuration")
    if data["transport"] not in ("ssl", "starttls"):
        raise ValueError("transport must be ssl or starttls")
    if type(data["port"]) is not int or not 1 <= data["port"] <= 65535:
        raise ValueError("invalid mail port")
    for key in ("host", "sender", "recipient"):
        if not isinstance(data[key], str) or "\n" in data[key] or "\r" in data[key]:
            raise ValueError("invalid mail configuration")
    user = data.get("username", "")
    password = data.get("password", "")
    if not isinstance(user, str) or not isinstance(password, str) or bool(user) != bool(password):
        raise ValueError("username and password must both be set or both be blank")
    return data


def send_failure_email(config: dict, reason: str, at: datetime) -> None:
    message = EmailMessage()
    message["From"] = config["sender"]
    message["To"] = config["recipient"]
    message["Subject"] = (
        "[ModelFlow] Backup alert TEST (no incident)"
        if reason == "SMTP_TEST_ONLY"
        else "[ModelFlow] Daily production backup FAILED"
    )
    header = ("ModelFlow backup alert delivery test; no incident has been detected.\n"
              if reason == "SMTP_TEST_ONLY" else "ModelFlow backup verification failed.\n")
    message.set_content(
        header +
        f"Check time (UTC): {at.astimezone(timezone.utc).isoformat()}\n"
        f"Failure code: {reason}\n\n"
        "Check the server's backups/auto/last-run.status and private backup logs.\n"
        "No credentials or backup contents are included in this alert.\n"
    )
    context = ssl.create_default_context()
    if config["transport"] == "ssl":
        client = smtplib.SMTP_SSL(config["host"], config["port"], timeout=15, context=context)
    else:
        client = smtplib.SMTP(config["host"], config["port"], timeout=15)
    with client as smtp:
        if config["transport"] == "starttls":
            smtp.starttls(context=context)
        if config.get("username"):
            smtp.login(config["username"], config["password"])
        smtp.send_message(message)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true", help="Read-only status check; never sends email")
    group.add_argument("--notify", action="store_true", help="Email only when the scheduled backup is unhealthy")
    group.add_argument("--test-email", action="store_true", help="Explicitly send one harmless delivery test")
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    if args.test_email:
        try:
            config = load_mail_config(DEFAULT_CONFIG)
            send_failure_email(config, "SMTP_TEST_ONLY", now)
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError, smtplib.SMTPException) as exc:
            print(f"BACKUP_ALERT_TEST_FAILED type={type(exc).__name__}", file=sys.stderr)
            return 1
        print("BACKUP_ALERT_TEST_SENT")
        return 0
    result = inspect_health(DEFAULT_AUTO_ROOT, now)
    if result == "PASS":
        print("MODELFLOW_BACKUP_HEALTH_PASS")
        return 0
    print(f"MODELFLOW_BACKUP_HEALTH_FAIL reason={result}", file=sys.stderr)
    if args.notify:
        try:
            config = load_mail_config(DEFAULT_CONFIG)
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
            print(f"BACKUP_ALERT_CONFIG_ERROR type={type(exc).__name__}", file=sys.stderr)
            return 1
        try:
            send_failure_email(config, result, now)
        except (OSError, ValueError, smtplib.SMTPException) as exc:
            print(f"BACKUP_ALERT_DELIVERY_FAILED type={type(exc).__name__}", file=sys.stderr)
            return 1
        print("BACKUP_ALERT_SENT", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
