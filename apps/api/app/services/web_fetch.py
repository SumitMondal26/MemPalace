"""Web fetch + content extraction — the P3.5 research agent's external eyes.

The agent's existing tools all read from the user's own data. This one
reaches outside — fetches an HTTP URL, extracts the readable text, hands
it back. Combined with `create_note` (from P3.3), the agent can now
expand the graph from external sources: paper abstracts, blog posts,
documentation pages.

The safety story matters more here than in any other tool. Every other
tool reads workspace data the user owns; this one talks to arbitrary
URLs. Wrong design = SSRF / DoS / leaking signed-URLs out / etc. So:

  - SSRF: refuse private IPs (10.*, 192.168.*, 127.*, link-local, etc.)
    AND any non-http(s) scheme (file://, javascript:, data:, etc.).
  - Timeout: 10s hard cap.
  - Size cap: refuse >5MB responses (read streaming, break early).
  - Content-type filter: only text/html and text/plain accepted.
  - User-Agent: identifies us honestly so admins can block if needed.
  - Failure: in-band — the agent sees {"error": "..."}, NOT a crash.
    Same pattern as every other tool: bad input → friendly error message.

What we don't do (yet, deliberately):
  - robots.txt: best-effort skipped for v1; single-user app, low risk.
  - per-domain rate limiting: same reason.
  - JS-rendered pages: too heavy for v1 (would need Playwright).
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

# Hard caps. Tuned for "a typical article fits, a paper PDF doesn't,
# nothing pathological gets through."
TIMEOUT_SECONDS = 10.0
MAX_BYTES = 5 * 1024 * 1024  # 5 MB
MAX_TEXT_CHARS = 6000        # in-result text cap so agent context doesn't balloon

# A short, honest UA. Tells admins what's hitting them. No spoofing.
USER_AGENT = "MemPalace/1.0 (+research agent; contact via the MemPalace project)"

# Content-types we'll parse. text/html is the bulk; text/plain handles
# raw markdown blogs, README dumps, paper plain-text mirrors.
ACCEPTED_CONTENT_TYPES = ("text/html", "text/plain", "application/xhtml+xml")

# Tags whose contents are noise — strip before extracting text.
NOISE_TAGS = (
    "script",
    "style",
    "noscript",
    "iframe",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "button",
    "svg",
    "template",
)


@dataclass
class FetchResult:
    ok: bool
    url: str
    final_url: str | None = None
    title: str | None = None
    text: str | None = None              # extracted main content, capped
    content_type: str | None = None
    byte_length: int | None = None
    error: str | None = None             # set when ok=False; user-facing


# ---------------------------------------------------------------------------
# Safety
# ---------------------------------------------------------------------------


def _is_private_ip(host: str) -> bool:
    """True if `host` resolves to a private/loopback/link-local IP.

    Resolves DNS first — defends against `http://attacker.com` where the
    A record points to 169.254.169.254 (cloud metadata) etc.

    On DNS failure we err on the side of "private" (refuse the fetch).
    Better to fail closed than open up an SSRF on a misconfigured host.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return True
    for fam, _, _, _, sockaddr in infos:
        addr = sockaddr[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return True
    return False


def _validate_url(url: str) -> str | None:
    """Return None if URL is safe to fetch, otherwise a user-facing error."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return (
            f"only http(s) URLs are allowed; got scheme {parsed.scheme!r}"
        )
    if not parsed.hostname:
        return "URL is missing a hostname"
    if _is_private_ip(parsed.hostname):
        return (
            "refusing to fetch private / loopback / link-local addresses "
            "(SSRF prevention)"
        )
    return None


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def _extract_main_text(html: str) -> tuple[str | None, str]:
    """Return (page_title, extracted_text).

    Strategy: parse with lxml backend, kill noise tags, prefer
    article-shaped containers (`<article>`, `<main>`, `[role=main]`),
    fall back to `<body>`. Collapse whitespace. Truncate to MAX_TEXT_CHARS.
    """
    soup = BeautifulSoup(html, "lxml")

    for t in soup.find_all(NOISE_TAGS):
        t.decompose()

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else None

    container = (
        soup.find("article")
        or soup.find("main")
        or soup.find(attrs={"role": "main"})
        or soup.body
        or soup
    )

    text = container.get_text(separator="\n", strip=True)
    # Collapse runs of blank lines + spaces — keeps the LLM context tight.
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()

    if len(text) > MAX_TEXT_CHARS:
        text = text[: MAX_TEXT_CHARS - 1] + "…"

    return title, text


# ---------------------------------------------------------------------------
# Fetch entry point
# ---------------------------------------------------------------------------


async def fetch_url(url: str) -> FetchResult:
    """Fetch + extract a URL. Always returns a FetchResult — never raises.

    Defensive across the board: SSRF check, timeout, size cap, content-
    type filter. Any failure path returns ok=False with a user-friendly
    error string — the agent sees it as a tool message and can decide
    how to react (try a different URL, give up, etc.).
    """
    validation_err = _validate_url(url)
    if validation_err:
        return FetchResult(ok=False, url=url, error=validation_err)

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(TIMEOUT_SECONDS),
            follow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        ) as client:
            # Stream so we can break early on oversize responses without
            # buffering them whole in memory.
            async with client.stream("GET", url) as resp:
                final_url = str(resp.url)
                # Re-validate the FINAL URL (post-redirects) against the
                # SSRF rules. Attacker-controlled URL could 302 to
                # http://169.254.169.254 — must not be naive about it.
                final_err = _validate_url(final_url)
                if final_err:
                    return FetchResult(
                        ok=False,
                        url=url,
                        final_url=final_url,
                        error=f"redirect target rejected: {final_err}",
                    )

                if resp.status_code >= 400:
                    return FetchResult(
                        ok=False,
                        url=url,
                        final_url=final_url,
                        error=f"HTTP {resp.status_code}",
                    )

                content_type = (resp.headers.get("content-type") or "").lower()
                ct_main = content_type.split(";", 1)[0].strip()
                if ct_main not in ACCEPTED_CONTENT_TYPES:
                    return FetchResult(
                        ok=False,
                        url=url,
                        final_url=final_url,
                        content_type=ct_main or None,
                        error=(
                            f"content-type {ct_main!r} not supported "
                            f"(only html / plaintext)"
                        ),
                    )

                # Read with size guard.
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_BYTES:
                        return FetchResult(
                            ok=False,
                            url=url,
                            final_url=final_url,
                            content_type=ct_main,
                            error=(
                                f"response exceeded {MAX_BYTES // 1024 // 1024} MB cap"
                            ),
                        )
                    chunks.append(chunk)

                body = b"".join(chunks)
                # Decode using the declared charset, fall back to utf-8.
                # Lots of pages mis-declare; we let httpx make the call.
                try:
                    text_html = body.decode(
                        resp.encoding or "utf-8", errors="replace"
                    )
                except LookupError:
                    text_html = body.decode("utf-8", errors="replace")

                # Plain-text path — no HTML parsing needed.
                if ct_main == "text/plain":
                    raw = text_html
                    if len(raw) > MAX_TEXT_CHARS:
                        raw = raw[: MAX_TEXT_CHARS - 1] + "…"
                    return FetchResult(
                        ok=True,
                        url=url,
                        final_url=final_url,
                        title=None,
                        text=raw.strip(),
                        content_type=ct_main,
                        byte_length=total,
                    )

                title, text = _extract_main_text(text_html)
                return FetchResult(
                    ok=True,
                    url=url,
                    final_url=final_url,
                    title=title,
                    text=text,
                    content_type=ct_main,
                    byte_length=total,
                )

    except httpx.TimeoutException:
        return FetchResult(
            ok=False, url=url, error=f"request timed out (>{TIMEOUT_SECONDS}s)"
        )
    except httpx.HTTPError as e:
        return FetchResult(ok=False, url=url, error=f"network error: {e}")
    except Exception as e:
        # Defensive last-resort. Should be unreachable; if not, we want
        # to see it as a friendly tool error rather than a 500.
        return FetchResult(ok=False, url=url, error=f"fetch failed: {e}")
