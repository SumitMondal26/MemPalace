"""OpenAI embedding wrapper.

Always batch. Sending one embedding at a time costs ~the same per token but
multiplies HTTP round-trip overhead by N. The OpenAI batch limit is high
enough (~2048 inputs / ~300K tokens per call) that for P1 we never hit it.
"""

from openai import AsyncOpenAI

from ..config import settings


async def embed_batch(client: AsyncOpenAI, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    resp = await client.embeddings.create(
        model=settings.openai_embedding_model,
        input=texts,
    )
    return [d.embedding for d in resp.data]
