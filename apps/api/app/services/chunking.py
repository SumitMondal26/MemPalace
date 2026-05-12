"""Token-aware chunker.

Why tokens not characters: embedding models think in tokens. A 1000-char chunk
is anywhere from 200 to 500 tokens depending on language and content.

Why overlap: a meaningful sentence might straddle a chunk boundary. Overlapping
~10% means at least one chunk preserves the full sentence intact.

P1 strategy: greedy fixed-size token chunks with overlap. Simple, predictable,
good baseline. P2 will add recursive splitting (paragraph → sentence → token)
which respects semantic structure better but is more work.
"""

from dataclasses import dataclass

import tiktoken

# cl100k_base is the tokenizer used by gpt-4 / gpt-4o-mini / text-embedding-3-*.
_ENC = tiktoken.get_encoding("cl100k_base")


@dataclass
class Chunk:
    content: str
    token_count: int


def chunk_text(
    text: str,
    target_tokens: int = 500,
    overlap_tokens: int = 50,
) -> list[Chunk]:
    text = text.strip()
    if not text:
        return []

    tokens = _ENC.encode(text)
    if not tokens:
        return []

    chunks: list[Chunk] = []
    step = max(1, target_tokens - overlap_tokens)

    i = 0
    while i < len(tokens):
        window = tokens[i : i + target_tokens]
        chunks.append(
            Chunk(
                content=_ENC.decode(window).strip(),
                token_count=len(window),
            )
        )
        if i + target_tokens >= len(tokens):
            break
        i += step

    return chunks
