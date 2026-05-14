"""Streaming chat completion wrapper + prompt assembly.

Split into:
  - SYSTEM_PROMPT: the rules
  - build_chat_messages(): pure function that assembles the messages array
    (visible to /chat for emitting as an `event: prompt` SSE frame, and
    for logging the exact payload sent to OpenAI).
  - stream_chat_messages(): streams the LLM response. Optionally captures
    OpenAI's token-usage report into a passed-in dict (in streaming mode you
    must request it via stream_options={"include_usage": True}).
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


def build_chat_messages(
    question: str,
    chunks: list[dict],
    history: list[dict] | None = None,
) -> list[dict]:
    """Pure function. Returns the messages array to send to OpenAI.

    Order: system → history (chronological) → current user turn with Context.
    """
    context = (
        "\n\n".join(f"[{i + 1}] {c['content']}" for i, c in enumerate(chunks))
        or "(no context found in user memory)"
    )
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        messages.extend(history)
    messages.append(
        {
            "role": "user",
            "content": f"Context:\n{context}\n\nQuestion: {question}",
        }
    )
    return messages


async def stream_chat_messages(
    openai: AsyncOpenAI,
    messages: list[dict],
    usage_out: dict | None = None,
) -> AsyncIterator[str]:
    """Stream tokens from a chat completion.

    If `usage_out` is provided, it gets mutated with `prompt_tokens` and
    `completion_tokens` from OpenAI's usage report (only delivered at end-of-
    stream when stream_options.include_usage is true).
    """
    stream = await openai.chat.completions.create(
        model=settings.openai_chat_model,
        messages=messages,
        stream=True,
        stream_options={"include_usage": True},
        temperature=0.2,
    )
    async for event in stream:
        if event.choices:
            delta = event.choices[0].delta.content
            if delta:
                yield delta
        if event.usage and usage_out is not None:
            usage_out["prompt_tokens"] = event.usage.prompt_tokens
            usage_out["completion_tokens"] = event.usage.completion_tokens


# Backward compatibility — older call sites that built messages internally.
async def stream_chat(
    openai: AsyncOpenAI,
    question: str,
    chunks: list[dict],
    history: list[dict] | None = None,
    usage_out: dict | None = None,
) -> AsyncIterator[str]:
    messages = build_chat_messages(question, chunks, history)
    async for token in stream_chat_messages(openai, messages, usage_out):
        yield token
