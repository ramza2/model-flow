import json
from io import BytesIO

import boto3
import pandas as pd
from botocore.client import Config

from app.core.config import settings


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=f"{'https' if settings.minio_secure else 'http'}://{settings.minio_endpoint}",
        aws_access_key_id=settings.minio_access_key,
        aws_secret_access_key=settings.minio_secret_key,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


def ensure_buckets() -> None:
    client = s3_client()
    existing = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
    for bucket in (settings.minio_datasets_bucket, settings.minio_mlflow_bucket):
        if bucket not in existing:
            client.create_bucket(Bucket=bucket)


def upload_bytes(bucket: str, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    s3_client().put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)


def download_bytes(bucket: str, key: str) -> bytes:
    obj = s3_client().get_object(Bucket=bucket, Key=key)
    return obj["Body"].read()


def profile_csv(data: bytes) -> tuple[int, int, list[str], dict]:
    df = pd.read_csv(BytesIO(data))
    columns = [str(c) for c in df.columns]
    stats: dict = {}
    for col in columns:
        series = df[col]
        entry: dict = {
            "dtype": str(series.dtype),
            "null_count": int(series.isna().sum()),
            "unique_count": int(series.nunique(dropna=True)),
        }
        if pd.api.types.is_numeric_dtype(series):
            entry.update(
                {
                    "min": float(series.min()) if series.notna().any() else None,
                    "max": float(series.max()) if series.notna().any() else None,
                    "mean": float(series.mean()) if series.notna().any() else None,
                    "std": float(series.std()) if series.notna().any() else None,
                }
            )
        else:
            top = series.astype(str).value_counts().head(5)
            entry["top_values"] = {str(k): int(v) for k, v in top.items()}
        stats[col] = entry
    return len(df), len(columns), columns, stats


def dumps(obj) -> str:
    return json.dumps(obj, default=str)
