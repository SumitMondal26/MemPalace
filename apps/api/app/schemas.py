"""Pydantic request/response models. Keep them in one file until pain demands more."""

from uuid import UUID

from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    node_id: UUID
    storage_path: str = Field(..., description="Path in the 'uploads' bucket")
    mime_type: str | None = None


class IngestResponse(BaseModel):
    chunks_created: int
    total_tokens: int
