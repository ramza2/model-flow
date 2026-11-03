#!/usr/bin/env python3
"""Offline regression for 03:00 KST backup health and SMTP alert safeguards."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from datetime import datetime, timezone

SCRIPT = Path(__file__).resolve().parent / "ops" / "check-backup-health.py"
SPEC = importlib.util.spec_from_file_location("modelflow_backup_health", SCRIPT)
health = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(health)

NOW = datetime(2026, 11, 2, 19, 0, tzinfo=timezone.utc)


class BackupHealthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="model-flow-health-test-")
        self.addCleanup(self.tmp.cleanup)
        self.auto = Path(self.tmp.name) / "backups" / "auto"
        self.auto.mkdir(parents=True)
        self.backup = self.auto / "auto-20261102T180000Z-321"
        self.backup.mkdir()
        (self.backup / "verified.ok").write_text(
            "verified_at=20261102T180004Z\n", encoding="utf-8"
        )
        self.status("SUCCESS", "20261102T180005Z", "0")

    def status(self, status, at, code):
        (self.auto / "last-run.status").write_text(
            f"status={status}\nfinished_at={at}\nexit_code={code}\n",
            encoding="utf-8",
        )

    def test_success_after_03_kst(self):
        self.assertEqual("PASS", health.inspect_health(self.auto, NOW))

    def test_failed_run(self):
        self.status("FAILED", "20261102T180005Z", "12")
        self.assertEqual("LAST_RUN_FAILED", health.inspect_health(self.auto, NOW))

    def test_previous_day_is_stale(self):
        self.status("SUCCESS", "20261101T180005Z", "0")
        self.assertEqual("LAST_RUN_STALE", health.inspect_health(self.auto, NOW))

    def test_missing_marker(self):
        (self.backup / "verified.ok").unlink()
        self.assertEqual("VERIFIED_MARKER_MISSING", health.inspect_health(self.auto, NOW))

    def test_missing_status(self):
        (self.auto / "last-run.status").unlink()
        self.assertEqual("STATUS_MISSING", health.inspect_health(self.auto, NOW))

    def test_marker_must_match_scheduled_day(self):
        (self.backup / "verified.ok").write_text(
            "verified_at=20261101T180005Z\n", encoding="utf-8"
        )
        self.assertEqual("VERIFIED_MARKER_MISSING", health.inspect_health(self.auto, NOW))

    def test_no_success_accepted_before_scheduled_window(self):
        early = datetime(2026, 11, 2, 17, 0, tzinfo=timezone.utc)
        self.assertEqual(
            "BEFORE_VERIFICATION_WINDOW", health.inspect_health(self.auto, early)
        )

    def test_status_safety(self):
        (self.auto / "last-run.status").write_text(
            "status=SUCCESS\nstatus=FAILED\nfinished_at=20261102T180005Z\nexit_code=0\n"
        )
        self.assertEqual("STATUS_INVALID", health.inspect_health(self.auto, NOW))

    def test_symlink_marker_not_accepted(self):
        (self.backup / "verified.ok").unlink()
        external = Path(self.tmp.name) / "external"
        external.write_text("verified_at=20261102T180004Z\n")
        (self.backup / "verified.ok").symlink_to(external)
        self.assertEqual("VERIFIED_MARKER_MISSING", health.inspect_health(self.auto, NOW))

    def test_mail_config_permissions_and_mock_delivery(self):
        config = Path(self.tmp.name) / "backup-alert.json"
        data = {
            "host": "smtp.example.invalid",
            "port": 465,
            "transport": "ssl",
            "sender": "alerts@example.invalid",
            "recipient": "ops@example.invalid",
            "username": "test",
            "password": "secret-not-logged",
        }
        config.write_text(json.dumps(data))
        os.chmod(config, 0o644)
        with self.assertRaises(ValueError):
            health.load_mail_config(config)
        os.chmod(config, 0o600)
        parsed = health.load_mail_config(config)
        fake_smtp = mock.MagicMock()
        fake_smtp.__enter__.return_value = fake_smtp
        with mock.patch.object(health.smtplib, "SMTP_SSL", return_value=fake_smtp) as transport:
            health.send_failure_email(parsed, "LAST_RUN_STALE", NOW)
        transport.assert_called_once()
        fake_smtp.login.assert_called_once_with("test", "secret-not-logged")
        message = fake_smtp.send_message.call_args.args[0]
        self.assertEqual("ops@example.invalid", message["To"])
        self.assertIn("LAST_RUN_STALE", message.get_content())
        self.assertNotIn("secret-not-logged", message.get_content())


if __name__ == "__main__":
    unittest.main(verbosity=2)
