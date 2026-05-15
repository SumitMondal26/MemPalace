"""Token-aware chunker.

Why tokens not characters: embedding models think in tokens. A 1000-char chunk
is anywhere from 200 to 500 tokens depending on language and content.

Why overlap: a meaningful sentence might straddle a chunk boundary. Overlapping
~10% means at least one chunk preserves the full sentence intact.

P1 strategy: greedy fixed-size token chunks with overlap. Simple, predictable,
good baseline. P2 will add recursive splitting (paragraph → sentence → token)
which respects semantic structure better but is more work.

`prepare_for_embedding` runs before chunking. Today it just strips URLs —
they're long strings of nonsense tokens to the embedder and dilute the
real signal. Same function used for url-type nodes (where the URL lives
in `content` alongside the user's caption) and note-type nodes that
happen to contain URLs.
"""

import re
from dataclasses import dataclass

import tiktoken

# Matches http(s) URLs. Conservative — stops at whitespace, parens, brackets,
# and common punctuation that isn't part of a URL. Anchored so it doesn't
# accidentally swallow normal prose.
_URL_RE = re.compile(r"https?://[^\s<>\)\]\}\,]+", re.IGNORECASE)


def prepare_for_embedding(text: str) -> str:
    """Normalize text before chunking + embedding.

    Currently: strip URLs, collapse the gaps left behind. URLs (especially
    YouTube ids, hashed asset paths, query strings) tokenize as long
    sequences of low-information characters that drown out the surrounding
    prose in the embedding. The visible `content` keeps them; the
    embedded text doesn't.

    If stripping leaves an empty string, returns "" — caller should treat
    that as "nothing to embed" the same way it would handle empty content.
    """
    if not text:
        return ""
    cleaned = _URL_RE.sub(" ", text)
    # Collapse runs of whitespace introduced by the substitution.
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned

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
