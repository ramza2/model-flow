#!/bin/bash
# One-shot init for disposable mssql-source (Compose profile: source).
# Creates database, dbo.customers seed, and a SELECT-only login.
set -euo pipefail

SQLCMD="${SQLCMD:-/opt/mssql-tools18/bin/sqlcmd}"
HOST="${SOURCE_MSSQL_HOST:-mssql-source}"
SA_PASSWORD="${SOURCE_MSSQL_SA_PASSWORD:?SOURCE_MSSQL_SA_PASSWORD is required}"
DB_NAME="${SOURCE_MSSQL_DB:?SOURCE_MSSQL_DB is required}"
READER_USER="${SOURCE_MSSQL_USER:?SOURCE_MSSQL_USER is required}"
READER_PASSWORD="${SOURCE_MSSQL_PASSWORD:?SOURCE_MSSQL_PASSWORD is required}"

run_sql() {
  "$SQLCMD" -S "$HOST" -U sa -P "$SA_PASSWORD" -C -b -V 16 "$@"
}

echo "Waiting for SQL Server at ${HOST}..."
for _ in $(seq 1 60); do
  if run_sql -Q "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
run_sql -Q "SELECT 1" >/dev/null

echo "Creating database ${DB_NAME} (if missing)..."
run_sql -Q "
IF DB_ID(N'${DB_NAME}') IS NULL
BEGIN
  DECLARE @sql nvarchar(max) = N'CREATE DATABASE [${DB_NAME}]';
  EXEC(@sql);
END
"

echo "Seeding dbo.customers and SELECT-only login..."
run_sql -d "$DB_NAME" -Q "
IF OBJECT_ID(N'dbo.customers', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.customers (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    email NVARCHAR(255) NOT NULL,
    segment NVARCHAR(64) NOT NULL,
    lifetime_value DECIMAL(12, 2) NOT NULL,
    created_at DATETIME2 NOT NULL CONSTRAINT DF_customers_created_at DEFAULT SYSUTCDATETIME()
  );
  INSERT INTO dbo.customers (name, email, segment, lifetime_value)
  VALUES
    (N'Ada Lovelace', N'ada@example.com', N'enterprise', 12500.00),
    (N'Grace Hopper', N'grace@example.com', N'growth', 7200.50),
    (N'Alan Turing', N'alan@example.com', N'starter', 1800.75);
END

IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'${READER_USER}')
BEGIN
  DECLARE @login_sql nvarchar(max) =
    N'CREATE LOGIN [${READER_USER}] WITH PASSWORD = N''${READER_PASSWORD}'', CHECK_POLICY = OFF';
  EXEC(@login_sql);
END

IF NOT EXISTS (
  SELECT 1 FROM sys.database_principals WHERE name = N'${READER_USER}'
)
BEGIN
  DECLARE @user_sql nvarchar(max) =
    N'CREATE USER [${READER_USER}] FOR LOGIN [${READER_USER}]';
  EXEC(@user_sql);
END

GRANT SELECT ON SCHEMA::dbo TO [${READER_USER}];
"

echo "mssql-source init complete."
