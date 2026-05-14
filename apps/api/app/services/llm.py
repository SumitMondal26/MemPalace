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

SYSTEM_PROMPT = """You are Mem Palace, an assistant that helps a user explore their saved memory.

You may receive prior conversation turns (user/assistant messages) before the current question. Use them to resolve pronouns and follow-up questions ("what about X?", "how does it work?", "the second one").

Each new user turn comes with a fresh Context section containing relevant chunks from the user's memory (or "(no context found in user memory)" if nothing relevant was retrieved).

Rules:
- Ground every factual claim in the CURRENT turn's Context. Do NOT treat your own prior assistant replies as authoritative — they could have been wrong, and the current Context is the source of truth for this turn.
- If the Context contains the answer, answer using ONLY the Context, and cite chunks with bracket numbers like [1], [2]. Cite specifically.
- If the Context does NOT contain the answer, OR the user is just chatting (greetings, meta-questions, "thanks"), respond conversationally and naturally. Keep it short.
- NEVER invent facts about the user, their notes, or their documents. If you don't have it in Context, don't claim it.
- Be concise. Don't restate the question. Don't pad with preamble.
""".strip()


async def stream_chat(
    openai: AsyncOpenAI,
    question: str,
    chunks: list[dict],
    history: list[dict] | None = None,
) -> AsyncIterator[str]:
    context = (
        "\n\n".join(f"[{i + 1}] {c['content']}" for i, c in enumerate(chunks))
        or "(no context found in user memory)"
    )

    # Order: system → prior turns (chronological) → current turn with Context.
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append(
        {
            "role": "user",
            "content": f"Context:\n{context}\n\nQuestion: {question}",
        }
    )

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
