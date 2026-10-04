"""SQLAlchemy engine/session setup. SQLite by default, PostgreSQL via ROADMIND_DATABASE_URL."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.types import TypeDecorator


class UTCDateTime(TypeDecorator):
    """Always store naive UTC and always return timezone-aware UTC datetimes."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value

    def process_result_value(self, value, dialect):
        return value.replace(tzinfo=timezone.utc) if value is not None else None


class Base(DeclarativeBase):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False})

        @event.listens_for(engine, "connect")
        def _pragma(dbapi_conn, _):  # enforce relationships in SQLite
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

        return engine
    return create_engine(url, pool_pre_ping=True)


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def ensure_schema(engine: Engine) -> list[str]:
    """Tiny additive migration: add any column the models have but an existing table lacks.

    `create_all` creates missing tables but never alters existing ones, so a database made by an older
    build would otherwise break (e.g. `users.email`). Only ADD COLUMN is done - nothing is dropped,
    renamed or rewritten. Returns the columns that were added.
    """
    from sqlalchemy import inspect, text

    added: list[str] = []
    insp = inspect(engine)
    sqlite = engine.dialect.name == "sqlite"
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(dialect=engine.dialect)}"
                default = col.default.arg if col.default is not None and getattr(col.default, "is_scalar", False) else None
                if isinstance(default, bool):
                    ddl += f" DEFAULT {1 if default else 0}" if sqlite else f" DEFAULT {'TRUE' if default else 'FALSE'}"
                elif isinstance(default, (int, float)):
                    ddl += f" DEFAULT {default}"
                elif isinstance(default, str):
                    ddl += " DEFAULT '" + default.replace("'", "''") + "'"
                conn.execute(text(ddl))
                added.append(f"{table.name}.{col.name}")
                if table.name == "users" and col.name == "email":  # uniqueness for rows added to an existing table
                    conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (email)"))
    return added
