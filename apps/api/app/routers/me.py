"""Auth round-trip test endpoint.

Hitting GET /me with a valid Supabase JWT returns the user's identity claims.
If this works, every other protected endpoint (nodes, ingest, chat) will too —
they all hang off the same get_claims / get_user_id dependency.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from ..deps import get_claims

router = APIRouter()


@router.get("/me")
async def me(claims: Annotated[dict, Depends(get_claims)]) -> dict:
    return {
        "id": claims.get("sub"),
        "email": claims.get("email"),
        "role": claims.get("role"),
        "aud": claims.get("aud"),
    }
