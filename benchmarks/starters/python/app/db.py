import os
import sqlite3

# The app's existing database. The tables in db/schema.sql already exist and hold real data.
# You may add your own tables.
DATABASE_PATH = os.environ.get("DATABASE_PATH", "data.db")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn
