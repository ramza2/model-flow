"""Retrain trigger records for drift/automation (Phase 1.1 manual retrain uses jobs API)."""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["retraining"])
