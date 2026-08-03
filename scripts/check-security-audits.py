#!/usr/bin/env python3
"""Fail when pip-audit or npm audit reports unallowlisted high-risk findings."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

BLOCKING_SEVERITIES = {"HIGH", "CRITICAL"}


@dataclass(frozen=True)
class Finding:
    source: str
    package: str
    severity: str
    identifiers: tuple[str, ...]
    summary: str


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path} is not readable JSON: {exc}") from exc


def pip_findings(report: dict[str, Any]) -> list[Finding]:
    dependencies = report.get("dependencies")
    if not isinstance(dependencies, list):
        raise ValueError("pip-audit report is missing dependencies[]")
    findings: list[Finding] = []
    for dependency in dependencies:
        package = str(dependency.get("name", "")).strip()
        for vulnerability in dependency.get("vulns") or []:
            primary = str(vulnerability.get("id", "")).strip()
            identifiers = tuple(
                dict.fromkeys(
                    item
                    for item in [primary, *(vulnerability.get("aliases") or [])]
                    if item
                )
            )
            # pip-audit's JSON format currently omits severity. Unknown severity
            # is treated as HIGH so a scanner schema gap cannot silently pass.
            severity = str(vulnerability.get("severity") or "HIGH").upper()
            findings.append(
                Finding(
                    source="pip-audit",
                    package=package,
                    severity=severity,
                    identifiers=identifiers or ("UNKNOWN",),
                    summary=str(vulnerability.get("description") or primary),
                )
            )
    return findings


def npm_identifiers(vulnerability: dict[str, Any], package: str) -> tuple[str, ...]:
    identifiers: list[str] = []
    for via in vulnerability.get("via") or []:
        if not isinstance(via, dict):
            continue
        url = str(via.get("url") or "")
        advisory = url.rstrip("/").rsplit("/", 1)[-1] if url else ""
        if advisory:
            identifiers.append(advisory)
        name = str(via.get("cve") or "").strip()
        if name:
            identifiers.append(name)
    return tuple(dict.fromkeys(identifiers)) or (f"npm:{package}",)


def npm_findings(report: dict[str, Any]) -> list[Finding]:
    vulnerabilities = report.get("vulnerabilities")
    if not isinstance(vulnerabilities, dict):
        raise ValueError("npm audit report is missing vulnerabilities{}")
    findings: list[Finding] = []
    for package, vulnerability in vulnerabilities.items():
        severity = str(vulnerability.get("severity") or "UNKNOWN").upper()
        summaries = [
            str(item.get("title"))
            for item in vulnerability.get("via") or []
            if isinstance(item, dict) and item.get("title")
        ]
        findings.append(
            Finding(
                source="npm-audit",
                package=str(package),
                severity=severity,
                identifiers=npm_identifiers(vulnerability, str(package)),
                summary="; ".join(summaries) or f"npm advisory for {package}",
            )
        )
    return findings


def active_allowlist(path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    document = load_json(path)
    entries = document.get("entries") if isinstance(document, dict) else None
    if not isinstance(entries, list):
        raise ValueError("allowlist must be an object with an entries[] array")
    active: list[dict[str, Any]] = []
    expired: list[dict[str, Any]] = []
    today = date.today()
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise ValueError(f"allowlist entry {index} must be an object")
        missing = [
            key
            for key in ("package", "cve", "reason", "expires")
            if not str(entry.get(key, "")).strip()
        ]
        if missing:
            raise ValueError(
                f"allowlist entry {index} is missing: {', '.join(missing)}"
            )
        try:
            expires = date.fromisoformat(str(entry["expires"]))
        except ValueError as exc:
            raise ValueError(
                f"allowlist entry {index} has invalid ISO expiry"
            ) from exc
        normalized = {
            **entry,
            "package": str(entry["package"]).lower(),
            "cve": str(entry["cve"]).upper(),
            "expires": expires.isoformat(),
        }
        (active if expires >= today else expired).append(normalized)
    return active, expired


def is_allowed(finding: Finding, allowlist: list[dict[str, Any]]) -> bool:
    package = finding.package.lower()
    identifiers = {identifier.upper() for identifier in finding.identifiers}
    return any(
        entry["package"] == package and entry["cve"] in identifiers
        for entry in allowlist
    )


def finding_out(finding: Finding) -> dict[str, Any]:
    return {
        "source": finding.source,
        "package": finding.package,
        "severity": finding.severity,
        "identifiers": list(finding.identifiers),
        "summary": finding.summary[:500],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pip", required=True, type=Path)
    parser.add_argument("--npm", required=True, type=Path, action="append")
    parser.add_argument("--allowlist", required=True, type=Path)
    args = parser.parse_args()
    try:
        findings = [
            *pip_findings(load_json(args.pip)),
            *(
                finding
                for report_path in args.npm
                for finding in npm_findings(load_json(report_path))
            ),
        ]
        allowlist, expired = active_allowlist(args.allowlist)
    except ValueError as exc:
        print(json.dumps({"status": "ERROR", "error": str(exc)}, indent=2))
        return 2

    blocking = [
        finding
        for finding in findings
        if finding.severity in BLOCKING_SEVERITIES
    ]
    suppressed = [finding for finding in blocking if is_allowed(finding, allowlist)]
    unsuppressed = [
        finding for finding in blocking if not is_allowed(finding, allowlist)
    ]
    result = {
        "status": "FAIL" if unsuppressed else "PASS",
        "blocking_severities": sorted(BLOCKING_SEVERITIES),
        "finding_count": len(findings),
        "blocking_count": len(blocking),
        "suppressed_count": len(suppressed),
        "unsuppressed": [finding_out(finding) for finding in unsuppressed],
        "expired_allowlist_entries": expired,
    }
    print(json.dumps(result, indent=2))
    return 1 if unsuppressed else 0


if __name__ == "__main__":
    sys.exit(main())
