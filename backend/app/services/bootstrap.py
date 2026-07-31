from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password
from app.db.models import User

logger = logging.getLogger(__name__)


def ensure_bootstrap_admin(db: Session) -> User | None:
    """Create the first system administrator from environment-backed settings.

    Existing installations are never modified. The unique email constraint also
    makes concurrent startup calls safe.
    """

    if db.scalar(select(User.id).limit(1)) is not None:
        return None

    password = settings.bootstrap_admin_password
    if not password:
        logger.warning(
            "No users exist and BOOTSTRAP_ADMIN_PASSWORD is empty; "
            "set it before attempting the first login."
        )
        return None

    admin = User(
        email=settings.bootstrap_admin_email.strip().lower(),
        full_name="ModelFlow Administrator",
        password_hash=hash_password(password),
        is_active=True,
        is_system_admin=True,
    )
    db.add(admin)
    try:
        db.commit()
    except IntegrityError:
        # Another process may have bootstrapped between the initial query and
        # insert. Treat that as successful idempotent initialization.
        db.rollback()
        return None
    db.refresh(admin)
    logger.info("Created bootstrap system administrator %s", admin.email)
    return admin
