"""Agent tool definitions — schemas + pure-function dispatch.

Two halves, deliberately split:

  Schemas (TOOL_SPECS) — what the LLM sees. JSON-Schema-flavored "tools"
  parameter format that OpenAI expects. The model picks tools by name +
  fills in the typed parameters.

  Dispatch (dispatch_tool) — what the server runs. Pure async functions
  that take parsed args + a context dict (sb_user, openai client) and
  return a JSON-serializable result. The result is what the LLM sees on
  its next iteration as a "tool" role message.

Why split this way:
  - The schema is what teaches the LLM what's possible. It's a contract
    we publish to the model. Reads cleanly as documentation.
  - The dispatch is what teaches our type checker what's safe. Runs on
    real types we trust. Doesn't pretend to be JSON.
  - Adding a tool = add one schema entry + one dispatch function. No
    framework, no decorators.

All four v1 tools are READ-ONLY. They search, fetch, and list — they
never mutate the user's graph. Write tools (create_note,
link_nodes) are deliberately deferred to P3.3 because the security and
audit story is heavier.

Tool result size: every dispatch return value is bounded (top-K results,
length-capped previews). The agent's context window grows with every
tool call, so we keep results small. A 5-iteration agent with 4 tools
each iteration = 20 tool results — they have to fit.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncOpenAI
from supabase import Client

from .retrieval import embed_query, search_chunks_with_neighbors
from .web_fetch import fetch_url

# Postgres uuid type rejects anything that isn't a real UUID. Validating in
# Python first lets us return a *helpful* error to the LLM ("you passed a
# label, did you mean the UUID from list_clusters()?") instead of the raw
# Postgres "22P02 invalid input syntax for type uuid" — which the model
# can recover from but loses ~300ms + tokens on the bad call.
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _validate_uuid(value: str, param_name: str, hint: str) -> str | None:
    """Return None if ok, otherwise a friendly error message for the LLM."""
    if not value:
        return f"{param_name} is required"
    if not _UUID_RE.match(value):
        return (
            f"{param_name} must be a UUID, got {value!r}. {hint}"
        )
    return None

# ---------------------------------------------------------------------------
# Tool schemas (what the LLM sees)
# ---------------------------------------------------------------------------

TOOL_SPECS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "search_memory",
            "description": (
                "Semantic search over the user's memory graph. Returns the top-k "
                "most relevant chunks with their parent node id, title, similarity "
                "score, and a content preview. Uses vector similarity + 1-hop "
                "graph expansion. Call this when the user asks about a topic and "
                "you need to find what's saved about it."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for. Be specific — name entities if you know them.",
                    },
                    "k": {
                        "type": "integer",
                        "description": "How many chunks to return (1-10). Default 5.",
                        "minimum": 1,
                        "maximum": 10,
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_node",
            "description": (
                "Fetch a node's full title + content + cluster label by id. Use "
                "this after search_memory when you need more than the chunk "
                "preview. Often the parent node has more context than any single "
                "chunk shows."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "node_id": {
                        "type": "string",
                        "description": (
                            "Node UUID — must be the `node_id` field returned "
                            "by search_memory or read_cluster_members. NOT a "
                            "title string."
                        ),
                    },
                },
                "required": ["node_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_clusters",
            "description": (
                "List all topic clusters in the workspace, with label and member "
                "count for each. Use this when the user asks broad questions "
                "(\"what topics do I have notes on?\") or when you need to "
                "navigate by topic instead of keyword."
            ),
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_cluster_members",
            "description": (
                "List the nodes (id + title) belonging to a cluster. Use this "
                "after list_clusters when the user wants details about a specific "
                "topic — you can then read_node on the most relevant members."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "cluster_id": {
                        "type": "string",
                        "description": (
                            "Cluster UUID — must be the `cluster_id` field "
                            "returned by list_clusters(). NOT the label string."
                        ),
                    },
                },
                "required": ["cluster_id"],
            },
        },
    },
    # ----- EXTERNAL tools (P3.5 — talk to the open web) -----
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": (
                "Fetch an http(s) URL and return its main readable content "
                "(article body, paper abstract, blog post, etc.). Use when "
                "the user gives you a URL to read, or asks you to research "
                "something against a specific source they reference. The "
                "fetch is bounded: 10s timeout, 5MB max, only html/plain. "
                "JS-heavy pages may return little or no content — fall "
                "back to asking the user for a static-readable URL."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": (
                            "Full http or https URL to fetch. Must include "
                            "the scheme. Private / loopback addresses are "
                            "rejected."
                        ),
                    },
                },
                "required": ["url"],
            },
        },
    },
    # ----- WRITE tools (proposals only; user must approve before they execute) -----
    {
        "type": "function",
        "function": {
            "name": "create_note",
            "description": (
                "Propose creating a new note in the user's memory. Use this "
                "whenever the user asks you to save, write down, remember, "
                "summarize, jot, or otherwise capture something — it covers "
                "summaries, lists, journal entries, plain notes, anything "
                "they want to preserve. "
                "This does NOT write immediately — it queues a proposal that "
                "the user reviews and approves before anything is created. "
                "Pass any source_node_ids you drew content from so the "
                "auto-connect pipeline can wire the new note into the right "
                "neighborhood (the IDs are a hint, not a hard link)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Short title for the new note (≤ 80 chars).",
                    },
                    "content": {
                        "type": "string",
                        "description": (
                            "The full content of the note. Plain text or "
                            "markdown. If summarizing existing notes, cite "
                            "them inline by title."
                        ),
                    },
                    "source_node_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Node UUIDs the note draws from (when applicable). "
                            "Stored as a hint; the auto-connect pipeline uses "
                            "similarity to form the actual edges. Must be "
                            "UUIDs from search_memory or read_cluster_members "
                            "output — NOT title strings. Empty / omitted for "
                            "standalone notes."
                        ),
                    },
                    "reason": {
                        "type": "string",
                        "description": (
                            "One-line rationale shown to the user in the "
                            "approval card. Why this note is worth creating."
                        ),
                    },
                },
                "required": ["title", "content"],
            },
        },
    },
]

TOOL_NAMES = {t["function"]["name"] for t in TOOL_SPECS}


# ---------------------------------------------------------------------------
# Dispatch (what the server runs)
# ---------------------------------------------------------------------------


@dataclass
class ToolContext:
    """Bag of dependencies the tools need. Built once per /agent request."""
    sb_user: Client
    openai: AsyncOpenAI
    workspace_id: str
    # Proposals queue for write tools (P3.3). Write tools don't write to the
    # graph directly — they append a dict here. The router collects this
    # list at the end of the agent loop and surfaces the proposals to the
    # user for approval. Empty for read-only agent runs.
    proposals: list[dict] = field(default_factory=list)


# Result size caps — every dispatch return MUST stay under these. The LLM's
# context window grows with each tool call; unbounded results would balloon
# cost + latency on a long agent run.
MAX_PREVIEW_CHARS = 240
MAX_LIST_ROWS = 50


@dataclass
class ToolDispatchResult:
    """Wrapper around tool return values that the agent loop consumes."""
    name: str
    ok: bool
    result: Any              # JSON-serializable; passed back to the LLM
    elapsed_ms: int
    error: str | None = None


def _preview(text: str, n: int = MAX_PREVIEW_CHARS) -> str:
    text = (text or "").strip()
    if len(text) <= n:
        return text
    return text[: n - 1] + "…"


async def _tool_search_memory(
    ctx: ToolContext, args: dict
) -> list[dict]:
    query = args.get("query", "").strip()
    k = int(args.get("k", 5))
    k = max(1, min(10, k))
    if not query:
        return []
    q_vec = await embed_query(ctx.openai, query)
    chunks = await search_chunks_with_neighbors(
        ctx.sb_user, q_vec, k, neighbor_count=1
    )

    # Resolve titles for the unique node ids (one round-trip).
    node_ids = list({c["node_id"] for c in chunks if c.get("node_id")})
    titles: dict[str, str] = {}
    if node_ids:
        rows = (
            ctx.sb_user.table("nodes")
            .select("id,title")
            .in_("id", node_ids)
            .execute()
        )
        titles = {r["id"]: (r.get("title") or "(untitled)") for r in (rows.data or [])}

    return [
        {
            "node_id": c.get("node_id"),
            "node_title": titles.get(c.get("node_id", ""), "(unknown)"),
            "similarity": round(float(c.get("similarity") or 0.0), 3),
            "source": c.get("source", "direct"),
            "preview": _preview(c.get("content") or ""),
        }
        for c in chunks
    ]


async def _tool_read_node(ctx: ToolContext, args: dict) -> dict:
    node_id = args.get("node_id", "").strip()
    err = _validate_uuid(
        node_id,
        "node_id",
        hint="Call search_memory first and pass its `node_id` field.",
    )
    if err:
        return {"error": err}
    row = (
        ctx.sb_user.table("nodes")
        .select("id,title,type,content,cluster_id")
        .eq("id", node_id)
        .maybe_single()
        .execute()
    )
    if not row or not row.data:
        return {"error": "node not found"}
    n = row.data
    cluster_label: str | None = None
    if n.get("cluster_id"):
        c = (
            ctx.sb_user.table("clusters")
            .select("label")
            .eq("id", n["cluster_id"])
            .maybe_single()
            .execute()
        )
        if c and c.data:
            cluster_label = c.data.get("label")
    # Cap the content too — agents have been known to call read_node on a
    # 50-page paper and choke on the result.
    content = n.get("content") or ""
    if len(content) > 2000:
        content = content[:1999] + "…"
    return {
        "id": n["id"],
        "title": n.get("title"),
        "type": n.get("type"),
        "content": content,
        "cluster_label": cluster_label,
    }


async def _tool_list_clusters(ctx: ToolContext, args: dict) -> list[dict]:
    rows = (
        ctx.sb_user.table("clusters")
        .select("id,label")
        .eq("workspace_id", ctx.workspace_id)
        .execute()
    )
    clusters = rows.data or []
    if not clusters:
        return []
    # Count members per cluster — one IN query, then bucket client-side.
    cluster_ids = [c["id"] for c in clusters]
    member_rows = (
        ctx.sb_user.table("nodes")
        .select("id,cluster_id")
        .eq("workspace_id", ctx.workspace_id)
        .in_("cluster_id", cluster_ids)
        .execute()
    )
    counts: dict[str, int] = {}
    for r in member_rows.data or []:
        cid = r.get("cluster_id")
        if cid:
            counts[cid] = counts.get(cid, 0) + 1
    return [
        {
            "cluster_id": c["id"],
            "label": c["label"],
            "member_count": counts.get(c["id"], 0),
        }
        for c in clusters
    ]


async def _tool_read_cluster_members(
    ctx: ToolContext, args: dict
) -> list[dict] | dict:
    cluster_id = args.get("cluster_id", "").strip()
    err = _validate_uuid(
        cluster_id,
        "cluster_id",
        hint=(
            "Call list_clusters() first to get the cluster UUIDs. The label "
            "string (e.g. 'Eijuuu References') is NOT a valid id."
        ),
    )
    if err:
        return {"error": err}
    rows = (
        ctx.sb_user.table("nodes")
        .select("id,title,type")
        .eq("workspace_id", ctx.workspace_id)
        .eq("cluster_id", cluster_id)
        .limit(MAX_LIST_ROWS)
        .execute()
    )
    return [
        {"node_id": r["id"], "title": r.get("title"), "type": r.get("type")}
        for r in (rows.data or [])
    ]


async def _tool_web_fetch(ctx: ToolContext, args: dict) -> dict:
    """Wraps services.web_fetch.fetch_url. Returns a slim dict the LLM
    can read efficiently — capping `text` here at the same MAX_TEXT_CHARS
    the service uses, so the agent's context doesn't balloon across
    multiple fetches in one run.
    """
    url = (args.get("url") or "").strip()
    if not url:
        return {"error": "url is required"}
    result = await fetch_url(url)
    if not result.ok:
        return {"error": result.error or "fetch failed", "url": url}
    return {
        "url": result.url,
        "final_url": result.final_url,
        "title": result.title,
        "text": result.text,
        "content_type": result.content_type,
        "byte_length": result.byte_length,
    }


async def _tool_create_note(
    ctx: ToolContext, args: dict
) -> dict:
    """Queue a create-note proposal. Does NOT write to the graph.

    The proposal lives in ctx.proposals until the router collects it. The
    router writes a corresponding agent_actions row (status='pending') and
    surfaces the proposal in the SSE `proposals` event. The user then
    approves or rejects via the dedicated endpoints. We never mutate state
    from inside a tool dispatch — keeps the agent loop's blast radius zero.

    The action_type stored in agent_actions is 'create_note' (was
    'create_summary_node' pre-migration 0016). Same payload shape:
    {title, content, source_node_ids}.
    """
    title = (args.get("title") or "").strip()
    content = (args.get("content") or "").strip()
    source_ids = args.get("source_node_ids") or []
    reason = (args.get("reason") or "").strip()

    if not title:
        return {"error": "title is required"}
    if not content:
        return {"error": "content is required"}
    if len(title) > 200:
        return {"error": "title too long (max 200 chars)"}
    # Validate source ids look like UUIDs — cheap guard against the
    # label-vs-uuid confusion we saw with cluster_id in P3.1 audit.
    cleaned_sources: list[str] = []
    bad_ids: list[str] = []
    for sid in source_ids:
        if not isinstance(sid, str):
            bad_ids.append(repr(sid))
            continue
        if _UUID_RE.match(sid.strip()):
            cleaned_sources.append(sid.strip())
        else:
            bad_ids.append(sid)
    if bad_ids:
        return {
            "error": (
                f"source_node_ids contained non-UUID values: {bad_ids[:3]}. "
                f"Each must be a node UUID from search_memory or "
                f"read_cluster_members."
            ),
        }

    proposal = {
        "action_type": "create_note",
        "payload": {
            "title": title,
            "content": content,
            "source_node_ids": cleaned_sources,
        },
        "reason": reason,
    }
    ctx.proposals.append(proposal)
    return {
        "queued": True,
        "summary": f"Proposal queued: create_note({title!r}) — pending user approval.",
    }


_DISPATCH = {
    "search_memory": _tool_search_memory,
    "read_node": _tool_read_node,
    "list_clusters": _tool_list_clusters,
    "read_cluster_members": _tool_read_cluster_members,
    "web_fetch": _tool_web_fetch,
    "create_note": _tool_create_note,
}


async def dispatch_tool(
    name: str, args: dict, ctx: ToolContext
) -> ToolDispatchResult:
    """Run one tool by name. Always returns a result — never raises.

    Tool-level exceptions become `ok=False` results. The agent loop feeds
    them back to the LLM as a tool message; the LLM can decide to retry
    with different args, give up, or move on. Keeping errors in-band is
    what lets agents recover without us hard-coding recovery logic.
    """
    t0 = time.perf_counter()
    fn = _DISPATCH.get(name)
    if fn is None:
        return ToolDispatchResult(
            name=name,
            ok=False,
            result={"error": f"unknown tool: {name}"},
            elapsed_ms=0,
            error=f"unknown tool: {name}",
        )
    try:
        result = await fn(ctx, args)
        return ToolDispatchResult(
            name=name,
            ok=True,
            result=result,
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
        )
    except Exception as e:
        return ToolDispatchResult(
            name=name,
            ok=False,
            result={"error": str(e)},
            elapsed_ms=int((time.perf_counter() - t0) * 1000),
            error=str(e),
        )
