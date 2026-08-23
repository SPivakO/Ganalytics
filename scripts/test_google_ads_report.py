from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("google_ads_report.py")
SPEC = importlib.util.spec_from_file_location("google_ads_report", MODULE_PATH)
report = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(report)


class ValidationTests(unittest.TestCase):
    def test_campaign_ids_are_numeric_and_deduplicated(self):
        self.assertEqual(report.normalize_campaign_ids("12, 34,12"), ["12", "34"])
        with self.assertRaises(ValueError):
            report.normalize_campaign_ids("12, bad")

    def test_date_range_is_bounded(self):
        self.assertEqual(report.validate_date_range("2026-08-01", "2026-08-23"), ("2026-08-01", "2026-08-23"))
        with self.assertRaises(ValueError):
            report.validate_date_range("2026-08-23", "2026-08-01")

    def test_gaql_string_escapes_user_input(self):
        self.assertEqual(report.gaql_string("O'Reilly\\test"), "'O\\'Reilly\\\\test'")

    def test_credentials_are_required_but_never_returned(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "ADS_DEVELOPER_TOKEN"):
                report.config_from_env()
        values = {
            "ADS_DEVELOPER_TOKEN": "secret-a",
            "ADS_CLIENT_ID": "secret-b",
            "ADS_CLIENT_SECRET": "secret-c",
            "ADS_REFRESH_TOKEN": "secret-d",
            "ADS_LOGIN_CUSTOMER_ID": "123-456-7890",
        }
        with patch.dict(os.environ, values, clear=True):
            config = report.config_from_env()
        self.assertEqual(config["login_customer_id"], "1234567890")
        self.assertNotIn("secret-a", str({"required": list(report.REQUIRED_ENV.values())}))

    def test_creative_name_normalization_is_conservative(self):
        raw = "0123456789abcdef0123456789abcdef_Castle_9x16 (123)"
        self.assertEqual(report.canonical_creative_name(raw), "Castle_9x16")


class MetricTests(unittest.TestCase):
    def test_metric_values_keep_google_conversion_semantics(self):
        metrics = SimpleNamespace(
            cost_micros=2_000_000,
            impressions=100,
            clicks=10,
            interactions=12,
            conversions=4.0,
            all_conversions=5.0,
            conversions_value=6.0,
        )
        values = report.metric_values(metrics)
        self.assertEqual(values["cost"], 2.0)
        self.assertEqual(values["cost_per_conversion"], 0.5)
        self.assertNotIn("installs", values)

    def test_error_artifact_contains_no_credential_values(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            report.write_json(output, {"ok": False, "credentials_included": False, "error": "missing secrets"})
            text = output.read_text(encoding="utf-8")
        self.assertIn('"credentials_included": false', text)
        self.assertNotIn("refresh_token", text)


class WorkflowContractTests(unittest.TestCase):
    def test_workflow_is_manual_read_only_and_uploads_artifact(self):
        workflow = MODULE_PATH.parent.parent / ".github" / "workflows" / "google-ads-report.yml"
        text = workflow.read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", text)
        self.assertIn("permissions:\n  contents: read", text)
        self.assertIn("actions/upload-artifact@v4", text)
        self.assertIn("INPUT_CAMPAIGN_NAME_CONTAINS: ${{ inputs.campaign_name_contains }}", text)
        self.assertNotIn('"${{ inputs.customer_id }}"', text)
        self.assertNotIn("mutate_", text)
        self.assertNotIn("docker", text.casefold())
        self.assertNotIn("pull_request:", text)


if __name__ == "__main__":
    unittest.main()
