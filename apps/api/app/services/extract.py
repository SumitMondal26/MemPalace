"""Extract text from raw upload bytes.

P1 supports PDF and plain text. Add more formats (docx, html, images) as
nodes start needing them — start with what you have.

Note on PDFs: pypdf works well on text PDFs but not on scanned PDFs (image-only).
For scanned PDFs we'd add OCR (tesseract / textract) in a later phase.
"""

from io import BytesIO


def extract_text(content: bytes, mime_type: str | None) -> str:
    if _looks_like_pdf(content, mime_type):
        from pypdf import PdfReader

        reader = PdfReader(BytesIO(content))
        return "\n\n".join((page.extract_text() or "").strip() for page in reader.pages)

    # Default: assume utf-8 text. errors='replace' so bad bytes don't crash us.
    return content.decode("utf-8", errors="replace")


def _looks_like_pdf(content: bytes, mime_type: str | None) -> bool:
    if mime_type and "pdf" in mime_type.lower():
        return True
    return content[:4] == b"%PDF"
