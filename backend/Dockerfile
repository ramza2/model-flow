FROM python:3.11-slim-bookworm

WORKDIR /app

# Microsoft ODBC Driver 18 for SQL Server (pinned package channel: Debian 12 / bookworm).
# unixODBC + msodbcsql18 are required by pyodbc; versions come from Microsoft's prod repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
    -o Acquire::Retries=5 \
    -o Acquire::http::Pipeline-Depth=0 \
    -o Acquire::http::No-Cache=true \
    build-essential curl gnupg apt-transport-https ca-certificates libpq-dev \
    && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /usr/share/keyrings/microsoft-prod.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
      > /etc/apt/sources.list.d/mssql-release.list \
    && apt-get update \
    && ACCEPT_EULA=Y apt-get install -y --no-install-recommends \
    -o Acquire::Retries=5 \
    -o Acquire::http::Pipeline-Depth=0 \
    -o Acquire::http::No-Cache=true \
    unixodbc unixodbc-dev msodbcsql18 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

ENV PYTHONPATH=/app
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
