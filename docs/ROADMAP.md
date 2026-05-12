# Roadmap

Mem Palace is built in four phases. Each phase has a *learning goal* (what you should be able to explain in an interview) and a *deliverable* (what works end-to-end).

## P1 — Foundation

**Learning goal:** End-to-end RAG. Auth, storage, embeddings, vector retrieval, streaming.

- [ ] Hosted Supabase project, migration applied, RLS verified with two users
- [ ] `docker compose up --build` brings up web + api (~60s on first build)
- [ ] Signup / login (Supabase Auth, email+password)
- [ ] Graph canvas: create, edit, delete, drag nodes; manual edges
- [ ] Upload PDF/text → stored in Supabase Storage → linked to a node
- [ ] Ingest pipeline: chunk → embed (`text-embedding-3-small`) → store in `chunks`
- [ ] `/chat` endpoint: top-k retrieval, OpenAI streaming via SSE
- [ ] Chat panel renders tokens live

## P2 — Smarter retrieval

**Learning goal:** Real retrieval engineering — chunking strategies, hybrid search, reranking, evals.

- [ ] Token-aware recursive chunking with overlap (tune for code vs prose)
- [ ] Hybrid retrieval: vector + Postgres `tsvector` BM25-style fulltext
- [ ] Reranking (LLM reranker or cross-encoder for top-N → top-K)
- [ ] Semantic edges job: nightly cosine-similarity sweep → `kind='semantic'` edges
- [ ] Redis + arq for background jobs (ingestion moves off the request path)

## P3 — Agents

**Learning goal:** Tool-using agents, reflection loops, multi-step orchestration without LangChain.

- [ ] Tool spec: `search_memory`, `read_node`, `link_nodes`, `summarize_cluster`, `create_node`
- [ ] Memory agent: clusters related nodes, writes summaries as new nodes
- [ ] Retrieval agent: rewrites queries, decides between vector / fulltext / graph traversal
- [ ] Reflection loop: critique-and-retry on low-confidence retrievals
- [ ] Research agent: takes a question, expands the graph from web results

## P4 — Observability & quality

**Learning goal:** AI you can debug, measure, and trust.

- [ ] Tracing (OpenTelemetry → Langfuse or Phoenix)
- [ ] Eval harness: golden Q→A set, recall@k, faithfulness, answer relevance
- [ ] Hallucination check: post-hoc verifier compares answer to retrieved context
- [ ] Memory compression: condense old clusters into summary nodes; preserve sources

---

## Verification (P1 smoke test)

After P1 ships, this should pass end-to-end:

1. `docker compose up --build` — both containers green within ~60s.
2. <http://localhost:3000>, sign up with a fresh email.
3. Supabase SQL editor: `select * from profiles, workspaces` shows the trigger-created rows.
4. Create a text node "Transformer architecture intro" with a paragraph of content.
5. Upload a PDF to a new doc node.
6. `select count(*) from chunks` is non-zero; FastAPI logs show chunking + embedding.
7. Chat panel: ask *"What is multi-head attention?"* — tokens stream, answer cites uploaded content.
8. Sign up as second user; confirm zero cross-user visibility (RLS works).
