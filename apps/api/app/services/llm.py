"""Streaming chat completion wrapper.

Prompt structure (boring on purpose — fancier templating waits for measurable
need):

    [system]   Mem Palace assistant rules + citation convention
    [user]     "Context:\n<numbered chunks>\n\nQuestion: <q>"

The numbered tags ([1], [2], ...) align with the `sources` event the router
emits before tokens, so the UI can resolve citations back to nodes.
"""

from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from ..config import settings

SYSTEM_PROMPT = """You are Mem Palace, an assistant that answers from the user's own saved memory.

Rules:
- Answer ONLY using the provided context. If the answer isn't there, say "I don't have that in your memory yet."
- Cite the chunks you used with bracket numbers like [1], [2]. Cite specifically — don't slap a citation on every sentence.
- Be concise. Don't restate the question. Don't pad with preamble.
""".strip()


async def stream_chat(
    openai: AsyncOpenAI,
    question: str,
    chunks: list[dict],
) -> AsyncIterator[str]:
    context = (
        "\n\n".join(f"[{i + 1}] {c['content']}" for i, c in enumerate(chunks))
        or "(no context found in user memory)"
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Context:\n{context}\n\nQuestion: {question}",
        },
    ]

    stream = await openai.chat.completions.create(
        model=settings.openai_chat_model,
        messages=messages,
        stream=True,
        temperature=0.2,
    )
    async for event in stream:
        if not event.choices:
            continue
        delta = event.choices[0].delta.content
        if delta:
            yield delta
