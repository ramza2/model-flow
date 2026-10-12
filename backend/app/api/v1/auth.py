from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.v1.common import audit_event, friendly, user_out
from app.core.audit import write_audit
from app.core.config import settings
from app.core.deps import AuthContext, client_ip, get_auth, get_request_id
from app.core.security import create_access_token, hash_password, verify_password
from app.db.models import User
from app.db.session import SessionLocal, get_db
from app.schemas.v1 import ChangePasswordRequest, LoginRequest, OidcExchangeRequest
from app.services import oidc as oidc_service
from app.services.oidc import OidcError

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


def _oidc_http_error(exc: OidcError, status_code: int = 400):
    return friendly(status_code, exc.public_message)


def _audit_oidc(
    db: Session,
    *,
    action: str,
    request: Request,
    success: bool,
    user: User | None = None,
    failure_reason: str | None = None,
    after: dict | None = None,
) -> None:
    write_audit(
        db,
        action=action,
        resource_type="user",
        resource_id=str(user.id) if user else None,
        user_id=user.id if user else None,
        user_email=user.email if user else None,
        success=success,
        ip_address=client_ip(request),
        request_id=get_request_id(request),
        failure_reason=failure_reason,
        after=after,
    )


@router.get("/methods")
def auth_methods():
    """Public, non-sensitive discovery of available sign-in methods."""

    return oidc_service.public_auth_methods()


@router.post("/login")
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)):
    email = str(body.email).strip().lower()
    user = db.scalar(
        select(User).where(func.lower(User.email) == email, User.deleted_at.is_(None))
    )
    now = datetime.now(timezone.utc)
    if user and _as_utc(user.locked_until) and _as_utc(user.locked_until) > now:
        write_audit(
            db,
            action="auth.login",
            resource_type="user",
            resource_id=str(user.id),
            user_id=user.id,
            user_email=user.email,
            success=False,
            ip_address=client_ip(request),
            request_id=get_request_id(request),
            failure_reason="account_locked",
        )
        db.commit()
        raise friendly(
            423,
            "This account is temporarily locked.",
            f"Try again after {user.locked_until.isoformat()}.",
        )

    if user and not bool(getattr(user, "local_login_enabled", True)):
        write_audit(
            db,
            action="auth.login",
            resource_type="user",
            resource_id=str(user.id),
            user_id=user.id,
            user_email=user.email,
            success=False,
            ip_address=client_ip(request),
            request_id=get_request_id(request),
            failure_reason="local_login_disabled",
        )
        db.commit()
        raise friendly(
            401,
            "Password sign-in is not enabled for this account.",
            "Use your organization SSO button, or contact an administrator.",
        )

    valid = bool(
        user and user.is_active and verify_password(body.password, user.password_hash)
    )
    if not valid:
        if user:
            user.failed_login_count = (user.failed_login_count or 0) + 1
            if user.failed_login_count >= settings.login_max_failures:
                user.locked_until = now + timedelta(
                    minutes=settings.login_lockout_minutes
                )
                user.failed_login_count = 0
        write_audit(
            db,
            action="auth.login",
            resource_type="user",
            resource_id=str(user.id) if user else None,
            user_id=user.id if user else None,
            user_email=user.email if user else email,
            success=False,
            ip_address=client_ip(request),
            request_id=get_request_id(request),
            failure_reason="invalid_credentials",
        )
        db.commit()
        raise friendly(
            401, "Invalid email or password.", "Check your credentials and try again."
        )

    user.failed_login_count = 0
    user.locked_until = None
    write_audit(
        db,
        action="auth.login",
        resource_type="user",
        resource_id=str(user.id),
        user_id=user.id,
        user_email=user.email,
        success=True,
        ip_address=client_ip(request),
        request_id=get_request_id(request),
    )
    db.commit()
    return {
        "access_token": create_access_token(str(user.id), {"tv": user.token_version}),
        "token_type": "bearer",
        "user": user_out(user),
    }


@router.get("/oidc/start")
def oidc_start(
    request: Request,
    return_to: str | None = None,
    db: Session = Depends(get_db),
):
    try:
        authorize_url, _row = oidc_service.begin_login_transaction(
            db, return_to=return_to
        )
        _audit_oidc(
            db,
            action="auth.oidc.start",
            request=request,
            success=True,
            after={"provider": settings.oidc_display_name},
        )
        db.commit()
    except OidcError as exc:
        _audit_oidc(
            db,
            action="auth.oidc.start",
            request=request,
            success=False,
            failure_reason=exc.category,
        )
        db.commit()
        raise _oidc_http_error(exc, status_code=400) from exc
    return RedirectResponse(url=authorize_url, status_code=302)


@router.get("/oidc/callback")
def oidc_callback(
    request: Request,
    db: Session = Depends(get_db),
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
):
    if error:
        # Never echo raw provider error/detail/token material to the client.
        try:
            oidc_service.handle_provider_error_callback(db, state=state)
            _audit_oidc(
                db,
                action="auth.oidc.login",
                request=request,
                success=False,
                failure_reason="provider_error",
            )
            db.commit()
        except OidcError as exc:
            _audit_oidc(
                db,
                action="auth.oidc.login",
                request=request,
                success=False,
                failure_reason=exc.category,
            )
            db.commit()
            return RedirectResponse(
                url="/login?oidc_error=" + quote(exc.public_message),
                status_code=302,
            )
        return RedirectResponse(
            url="/login?oidc_error=" + quote("Sign-in was cancelled or denied."),
            status_code=302,
        )
    try:
        exchange_code, return_to, user, kind = oidc_service.complete_callback(
            db, state=state or "", code=code or ""
        )
        action = {
            "login": "auth.oidc.login",
            "link": "auth.oidc.link",
            "provision": "auth.oidc.provision",
        }.get(kind, "auth.oidc.login")
        _audit_oidc(
            db,
            action=action,
            request=request,
            success=True,
            user=user,
            after={"provider": settings.oidc_display_name, "mapping": kind},
        )
        # Successful callback also records a login event when linking/provisioning.
        if kind in {"link", "provision"}:
            _audit_oidc(
                db,
                action="auth.oidc.login",
                request=request,
                success=True,
                user=user,
                after={"provider": settings.oidc_display_name, "mapping": kind},
            )
        db.commit()
        redirect = oidc_service.frontend_callback_redirect_url(
            exchange_code=exchange_code, return_to=return_to
        )
        return RedirectResponse(url=redirect, status_code=302)
    except OidcError as exc:
        _audit_oidc(
            db,
            action="auth.oidc.login",
            request=request,
            success=False,
            failure_reason=exc.category,
        )
        db.commit()
        return RedirectResponse(
            url="/login?oidc_error=" + quote(exc.public_message),
            status_code=302,
        )


@router.post("/oidc/exchange")
def oidc_exchange(
    body: OidcExchangeRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    try:
        user = oidc_service.consume_exchange_code(db, body.code)
        _audit_oidc(
            db,
            action="auth.oidc.exchange",
            request=request,
            success=True,
            user=user,
            after={"provider": settings.oidc_display_name},
        )
        db.commit()
    except OidcError as exc:
        _audit_oidc(
            db,
            action="auth.oidc.exchange",
            request=request,
            success=False,
            failure_reason=exc.category,
        )
        db.commit()
        raise _oidc_http_error(exc, status_code=400) from exc
    return {
        "access_token": create_access_token(str(user.id), {"tv": user.token_version}),
        "token_type": "bearer",
        "user": user_out(user),
    }


@router.post("/logout")
def logout(auth: AuthContext = Depends(get_auth), db: Session = Depends(get_db)):
    auth.user.token_version += 1
    audit_event(db, auth, "auth.logout", "user", auth.user.id)
    db.commit()
    return {
        "detail": "Logged out.",
        "hint": "All access tokens for this user have been revoked. Sign in again to continue.",
    }


@router.get("/me")
def me(auth: AuthContext = Depends(get_auth)):
    return user_out(auth.user)


@router.post("/change-password")
def change_password(
    body: ChangePasswordRequest,
    auth: AuthContext = Depends(get_auth),
    db: Session = Depends(get_db),
):
    if not bool(getattr(auth.user, "local_login_enabled", True)):
        audit_event(
            db,
            auth,
            "auth.change_password",
            "user",
            auth.user.id,
            success=False,
            failure_reason="local_login_disabled",
        )
        db.commit()
        raise friendly(
            400,
            "Password change is not available for SSO-only accounts.",
            "Sign in with your organization SSO provider.",
        )
    if not verify_password(body.current_password, auth.user.password_hash):
        audit_event(
            db,
            auth,
            "auth.change_password",
            "user",
            auth.user.id,
            success=False,
            failure_reason="current_password_invalid",
        )
        db.commit()
        raise friendly(400, "Current password is incorrect.")
    if body.current_password == body.new_password:
        raise friendly(400, "New password must be different from the current password.")
    auth.user.password_hash = hash_password(body.new_password)
    auth.user.token_version += 1
    audit_event(db, auth, "auth.change_password", "user", auth.user.id)
    db.commit()
    return {
        "detail": "Password changed.",
        "hint": "Sign in again with the new password.",
    }


def bootstrap_admin() -> None:
    """Create the first system administrator only when explicitly configured."""
    db = SessionLocal()
    try:
        if db.scalar(select(User.id).limit(1)) is not None:
            return
        if not settings.bootstrap_admin_password:
            logger.warning("bootstrap_admin_skipped reason=password_not_configured")
            return
        existing = db.scalar(
            select(User).where(
                func.lower(User.email) == settings.bootstrap_admin_email.lower()
            )
        )
        if existing:
            return
        user = User(
            email=settings.bootstrap_admin_email.strip().lower(),
            full_name="ModelFlow Administrator",
            password_hash=hash_password(settings.bootstrap_admin_password),
            is_active=True,
            is_system_admin=True,
            local_login_enabled=True,
        )
        db.add(user)
        db.flush()
        write_audit(
            db,
            action="user.bootstrap",
            resource_type="user",
            resource_id=str(user.id),
            user_id=user.id,
            user_email=user.email,
        )
        db.commit()
        logger.info("bootstrap_admin_created user_id=%s email=%s", user.id, user.email)
    except Exception:
        db.rollback()
        logger.exception("bootstrap_admin_failed")
        raise
    finally:
        db.close()
