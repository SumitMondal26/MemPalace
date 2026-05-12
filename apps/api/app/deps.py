"""FastAPI dependencies: JWT verification (HS256 or JWKS), Supabase clients, OpenAI.

JWT verification supports two modes — picked based on the token's `alg` header:

- HS256: legacy shared-secret HMAC. Used by Supabase for anon / service_role
  keys, and by older projects for user tokens too. Verified against
  SUPABASE_JWT_SECRET.

- ES256 / EdDSA / RS256: asymmetric signing. New Supabase projects sign user
  tokens this way. We fetch the public keys from JWKS at
    <SUPABASE_URL>/auth/v1/.well-known/jwks.json
  match by `kid`, and verify with the public half. The private key never
  leaves Supabase.

JWKS is cached in-process; on an unknown `kid` we evict + retry once to
absorb key rotation without restarting the process.
"""

import asyncio
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException, status
from jose import JWTError, jwt
from openai import AsyncOpenAI
from supabase import Client, create_client

from .config import settings


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    return authorization.split(" ", 1)[1].strip()


# ---------------------------------------------------------------------------
# JWKS cache for asymmetric verification
# ---------------------------------------------------------------------------

_JWKS_URL = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
_ASYMMETRIC_ALGS = {"ES256", "EdDSA", "RS256"}

_jwks_cache: dict | None = None
_jwks_lock = asyncio.Lock()


async def _load_jwks() -> dict:
    global _jwks_cache
    if _jwks_cache is None:
        async with _jwks_lock:
            if _jwks_cache is None:
                async with httpx.AsyncClient(timeout=5.0) as client:
                    resp = await client.get(_JWKS_URL)
                    resp.raise_for_status()
                    _jwks_cache = resp.json()
    return _jwks_cache


def _evict_jwks() -> None:
    global _jwks_cache
    _jwks_cache = None


async def _key_for(kid: str | None) -> dict | None:
    if not kid:
        return None
    jwks = await _load_jwks()
    return next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def get_token(
    authorization: Annotated[str | None, Header()] = None,
) -> str:
    return _extract_bearer(authorization)


async def get_claims(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    token = _extract_bearer(authorization)
    try:
        header = jwt.get_unverified_header(token)
    except JWTError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail=f"malformed token: {e}") from e

    alg = header.get("alg")
    try:
        if alg == "HS256":
            return jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
            )

        if alg in _ASYMMETRIC_ALGS:
            kid = header.get("kid")
            key = await _key_for(kid)
            if key is None:
                # Maybe Supabase rotated the key — evict cache and retry once.
                _evict_jwks()
                key = await _key_for(kid)
                if key is None:
                    raise HTTPException(
                        status.HTTP_401_UNAUTHORIZED,
                        detail=f"unknown key id: {kid}",
                    )
            return jwt.decode(
                token,
                key,
                algorithms=[alg],
                audience="authenticated",
            )

        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail=f"unsupported alg: {alg}",
        )

    except JWTError as e:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, detail=f"invalid token: {e}"
        ) from e


async def get_user_id(
    claims: Annotated[dict, Depends(get_claims)],
) -> str:
    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="token missing sub")
    return sub


# ---------------------------------------------------------------------------
# Supabase clients
# ---------------------------------------------------------------------------


def supabase_user(token: Annotated[str, Depends(get_token)]) -> Client:
    """Anon key + caller's JWT. PostgREST resolves auth.uid() — RLS applies."""
    client = create_client(settings.supabase_url, settings.supabase_anon_key)
    client.postgrest.auth(token)
    return client


def supabase_admin() -> Client:
    """Service-role key. Bypasses RLS. Use only for system jobs."""
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


# ---------------------------------------------------------------------------
# OpenAI
# ---------------------------------------------------------------------------

_openai_client: AsyncOpenAI | None = None


def openai_client() -> AsyncOpenAI:
    global _openai_client
    if _openai_client is None:
        _openai_client = AsyncOpenAI(api_key=settings.openai_api_key)
    return _openai_client
