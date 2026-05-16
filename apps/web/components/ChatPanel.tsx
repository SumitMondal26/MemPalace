"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import * as db from "@/lib/db";
import { useGraphStore } from "@/lib/store";
import { supabase } from "@/lib/supabase";

type Source = {
  i: number;
  id: string;
  node_id: string;
  similarity: number | null;
  preview: string;
  source?: "direct" | "neighbor";
};

type Stage = {
  label: string;
  elapsed_ms: number;
};

type PromptInfo = {
  messages: { role: string; content: string }[];
  model: string;
  temperature: number;
};

type RewriteInfo = {
  original: string;
  rewritten: string;
  was_rewritten: boolean;
  elapsed_ms: number;
};

type RerankInfo = {
  was_reranked: boolean;
  skip_reason: string | null;
  elapsed_ms: number;
  movement: [number, number, string][];
};

type DoneInfo = {
  elapsed_ms: number;
  embed_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
};

/** One agent step: either a tool call or its result. The trace UI renders
 *  them as a collapsible row each; pairing a `tool_call` with its
 *  `tool_result` happens via tool_call_id.
 *  `attempt` distinguishes the first agent pass from the post-reflection
 *  retry pass so the UI can visually separate them. */
type AgentStep =
  | {
      kind: "tool_call";
      iter: number;
      name: string;
      args: Record<string, unknown>;
      tool_call_id: string;
      elapsed_ms: number;
      attempt?: "first" | "retry";
    }
  | {
      kind: "tool_result";
      iter: number;
      name: string;
      tool_call_id: string;
      ok: boolean;
      result_preview: string;
      tool_ms: number;
      elapsed_ms: number;
      attempt?: "first" | "retry";
    };

/** A write-tool proposal returned by /agent. The user reviews each one and
 *  approves/rejects via /agent/proposals/{id}/{approve|reject}. */
type AgentProposal = {
  id: string;
  action_type: "create_summary_node";
  payload: {
    title?: string;
    content?: string;
    source_node_ids?: string[];
  };
  reason?: string | null;
  attempt?: "first" | "retry";
  /** Local UI state — not from the server. Tracks our optimistic transition
   *  through approve/reject calls. */
  uiStatus?: "pending" | "approving" | "approved" | "rejecting" | "rejected" | "error";
  resultNodeId?: string | null;
  errorDetail?: string;
};

type ReflectionInfo = {
  /** Score of the SHIPPED answer (max of first/retry when retry happened). */
  score: number;        // 1-5
  /** Score of the first attempt — set on both reflection events so the
   *  UI can show "originally X, retried, now Y". */
  score_first?: number;
  /** Judge's issues on the attempt this event describes. */
  issues: string;
  /** True only on the first event when score_first < threshold AND retry
   *  is about to fire. The second reflection event always has retrying=false. */
  retrying: boolean;
  /** "first" (implicit, omitted) or "retry" — which attempt this judge call
   *  scored. Two reflection events fire when retry happens; the second one
   *  describes the retry's quality. */
  attempt?: "first" | "retry";
  elapsed_ms: number;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  trace?: Stage[];
  prompt?: PromptInfo;
  rewrite?: RewriteInfo;
  rerank?: RerankInfo;
  done?: DoneInfo;
  /** Set when this turn used the agent path. The trace UI renders agentSteps
   *  inline with stages so the user sees tool calls in time order. */
  agentSteps?: AgentStep[];
  agentIterations?: number;
  agentHitIterCap?: boolean;
  /** First judge call's result. Always set on agent runs with reflection on. */
  reflection?: ReflectionInfo;
  /** Second judge call's result (only when retry happened). When present,
   *  the chip shows the *shipped* answer's score by picking the higher one. */
  reflectionRetry?: ReflectionInfo;
  reflectionRetried?: boolean;
  /** Set when the retry's answer scored worse than the first — the bubble
   *  shows the first answer instead. Lets the trace UI explain why the
   *  visible answer doesn't match the last `final` event in time order. */
  shippedFirstAnswer?: boolean;
  /** Write proposals queued by the agent. Each one is a `pending`
   *  agent_actions row server-side until the user approves or rejects. */
  proposals?: AgentProposal[];
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Agent mode toggle. /chat = single-pass RAG (cheaper, faster).
  // /agent = multi-step LLM-tools loop (richer reasoning, ~3× cost & latency).
  const [agentMode, setAgentMode] = useState(false);
  // Pulled from the store so we can refetch the graph after a proposal is
  // approved (new node + edges appear in the 3D canvas immediately).
  const workspaceId = useGraphStore((s) => s.workspaceId);
  const upsertNode = useGraphStore((s) => s.upsertNode);
  const setEdges = useGraphStore((s) => s.setEdges);
  const selectNode = useGraphStore((s) => s.selectNode);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send() {
    const q = input.trim();
    if (!q || loading) return;

    // Snapshot conversation history BEFORE adding the new turn so the
    // request body sees only completed prior turns. Drop empty placeholders
    // (e.g. an assistant bubble still streaming would be empty here).
    const history = messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    setInput("");
    setLoading(true);

    setMessages((m) => [
      ...m,
      { role: "user", content: q },
      { role: "assistant", content: "", sources: [], trace: [] },
    ]);

    const { data: sessionData } = await supabase().auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      appendToAssistant(" (not signed in)");
      setLoading(false);
      return;
    }

    try {
      const endpoint = agentMode ? "/agent" : "/chat";
      const body = agentMode
        ? { question: q, history }
        : { question: q, k: 5, history };
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        appendToAssistant(` (error ${res.status}: ${detail})`);
        setLoading(false);
        return;
      }
      await consumeStream(res.body);
    } catch (e) {
      appendToAssistant(
        ` (network error: ${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      setLoading(false);
    }
  }

  function mutateLastAssistant(fn: (m: Message) => Message) {
    setMessages((all) => {
      const next = all.slice();
      const last = next[next.length - 1];
      if (last?.role === "assistant") next[next.length - 1] = fn(last);
      return next;
    });
  }

  function appendToAssistant(text: string) {
    mutateLastAssistant((m) => ({ ...m, content: m.content + text }));
  }

  function pushStage(stage: Stage) {
    mutateLastAssistant((m) => ({
      ...m,
      trace: [...(m.trace ?? []), stage],
    }));
  }

  function setSources(sources: Source[]) {
    mutateLastAssistant((m) => ({ ...m, sources }));
  }

  function setPrompt(prompt: PromptInfo) {
    mutateLastAssistant((m) => ({ ...m, prompt }));
  }

  function setRewrite(rewrite: RewriteInfo) {
    mutateLastAssistant((m) => ({ ...m, rewrite }));
  }

  function setRerank(rerank: RerankInfo) {
    mutateLastAssistant((m) => ({ ...m, rerank }));
  }

  function pushAgentStep(step: AgentStep) {
    mutateLastAssistant((m) => ({
      ...m,
      agentSteps: [...(m.agentSteps ?? []), step],
    }));
  }

  function setAgentMeta(iters: number, hitCap: boolean) {
    mutateLastAssistant((m) => ({
      ...m,
      agentIterations: iters,
      agentHitIterCap: hitCap,
    }));
  }

  function setReflection(reflection: ReflectionInfo) {
    // Route by attempt tag — the server emits the first judge with no
    // attempt (or "first"), the second judge with attempt="retry".
    mutateLastAssistant((m) => {
      if (reflection.attempt === "retry") {
        return { ...m, reflectionRetry: reflection };
      }
      return { ...m, reflection };
    });
  }

  function setReflectionRetried(retried: boolean) {
    mutateLastAssistant((m) => ({ ...m, reflectionRetried: retried }));
  }

  function markShippedFirst() {
    mutateLastAssistant((m) => ({ ...m, shippedFirstAnswer: true }));
  }

  function setProposals(proposals: AgentProposal[]) {
    mutateLastAssistant((m) => ({
      ...m,
      proposals: proposals.map((p) => ({ ...p, uiStatus: "pending" as const })),
    }));
  }

  /** Mutate one proposal by id within the LATEST assistant message. The
   *  proposals card is anchored there; older messages don't change. */
  function updateProposal(id: string, patch: Partial<AgentProposal>) {
    mutateLastAssistant((m) => ({
      ...m,
      proposals: (m.proposals ?? []).map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      ),
    }));
  }

  function markDone(done: DoneInfo) {
    mutateLastAssistant((m) => ({ ...m, done }));
  }

  async function consumeStream(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        handleFrame(frame);
      }
    }
  }

  function handleFrame(frame: string) {
    let event: string | null = null;
    let dataLine: string | null = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLine = line.slice(6);
    }
    if (!event || dataLine == null) return;

    let payload: unknown = null;
    try {
      payload = JSON.parse(dataLine);
    } catch {
      payload = dataLine;
    }

    if (event === "token" && typeof payload === "string") {
      appendToAssistant(payload);
    } else if (event === "sources" && Array.isArray(payload)) {
      setSources(payload as Source[]);
    } else if (event === "stage" && payload && typeof payload === "object") {
      pushStage(payload as Stage);
    } else if (event === "prompt" && payload && typeof payload === "object") {
      setPrompt(payload as PromptInfo);
    } else if (event === "rewrite" && payload && typeof payload === "object") {
      setRewrite(payload as RewriteInfo);
    } else if (event === "rerank" && payload && typeof payload === "object") {
      setRerank(payload as RerankInfo);
    } else if (event === "tool_call" && payload && typeof payload === "object") {
      pushAgentStep({ kind: "tool_call", ...(payload as Omit<Extract<AgentStep, { kind: "tool_call" }>, "kind">) });
    } else if (event === "tool_result" && payload && typeof payload === "object") {
      pushAgentStep({ kind: "tool_result", ...(payload as Omit<Extract<AgentStep, { kind: "tool_result" }>, "kind">) });
    } else if (event === "final" && payload && typeof payload === "object") {
      // Agent path delivers the final answer as one event (no token stream).
      // - first attempt: sets the answer.
      // - retry: overwrites the answer.
      // - first-restored: the second judge rejected the retry; we put the
      //   first attempt's answer back into the bubble.
      const p = payload as { content: string; iter_used: number; attempt?: string };
      mutateLastAssistant((m) => ({ ...m, content: p.content }));
      if (p.attempt === "first-restored") {
        markShippedFirst();
      } else {
        setAgentMeta(p.iter_used, false);
      }
    } else if (event === "proposals" && payload && typeof payload === "object") {
      const p = payload as { items?: AgentProposal[] };
      if (Array.isArray(p.items)) setProposals(p.items);
    } else if (event === "reflection" && payload && typeof payload === "object") {
      setReflection(payload as ReflectionInfo);
    } else if (event === "done" && payload && typeof payload === "object") {
      const p = payload as DoneInfo & {
        iterations?: number;
        hit_iter_cap?: boolean;
        reflection_retried?: boolean;
      };
      markDone(p);
      if (typeof p.iterations === "number") {
        setAgentMeta(p.iterations, !!p.hit_iter_cap);
      }
      if (typeof p.reflection_retried === "boolean") {
        setReflectionRetried(p.reflection_retried);
      }
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 left-6 z-20 flex items-center gap-2 rounded-full bg-palace-accent px-5 py-3 text-sm font-medium text-white shadow-xl shadow-palace-accent/30 hover:bg-palace-accent/90"
      >
        Ask your memory
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 left-6 z-20 flex h-[640px] w-[440px] flex-col rounded-2xl bg-palace-panel shadow-2xl ring-1 ring-palace-edge">
      <header className="flex items-center justify-between border-b border-palace-edge px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Ask your memory</h3>
          <p className="text-[10px] text-neutral-500">
            Answers come only from your saved memory.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMessages([])}
            disabled={loading || messages.length === 0}
            className="rounded px-2 py-1 text-[11px] text-neutral-500 hover:bg-palace-bg hover:text-neutral-200 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-500"
            title="Clear conversation"
          >
            Clear
          </button>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 text-lg text-neutral-500 hover:bg-palace-bg hover:text-neutral-100"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="text-xs text-neutral-500">
            Try{" "}
            <em className="text-neutral-400">
              &ldquo;What is multi-head attention?&rdquo;
            </em>{" "}
            or ask about your own notes.
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <UserBubble key={i} content={m.content} />
          ) : (
            <AssistantTurn
              key={i}
              message={m}
              isStreaming={i === messages.length - 1 && loading}
              onProposalUpdate={updateProposal}
            />
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="space-y-2 border-t border-palace-edge p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          placeholder={
            agentMode
              ? "Ask anything — agent will search & reason in steps"
              : "What's in your memory?"
          }
          className="w-full rounded-lg bg-palace-bg px-3 py-2 text-sm outline-none ring-1 ring-palace-edge focus:ring-palace-accent disabled:opacity-50"
        />
        <div className="flex items-center justify-between text-[10px] text-neutral-500">
          <label className="flex cursor-pointer items-center gap-1.5 select-none">
            <input
              type="checkbox"
              checked={agentMode}
              onChange={(e) => setAgentMode(e.target.checked)}
              disabled={loading}
              className="accent-palace-accent"
            />
            <span className={agentMode ? "text-palace-accent" : ""}>
              🤖 Agent mode
            </span>
          </label>
          <span className="text-neutral-600">
            {agentMode
              ? "multi-step · search + read tools · ~3× cost"
              : "single-pass RAG"}
          </span>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// sub-components
// ---------------------------------------------------------------------------

function UserBubble({ content }: { content: string }) {
  return (
    <div className="text-right">
      <div className="inline-block max-w-[90%] whitespace-pre-wrap rounded-2xl bg-palace-accent px-3 py-2 text-sm leading-relaxed text-white">
        {content}
      </div>
    </div>
  );
}

function AssistantTurn({
  message,
  isStreaming,
  onProposalUpdate,
}: {
  message: Message;
  isStreaming: boolean;
  onProposalUpdate: (id: string, patch: Partial<AgentProposal>) => void;
}) {
  const trace = message.trace ?? [];
  const isDone = message.done != null;
  const [expandedI, setExpandedI] = useState<number | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const expandedSource =
    expandedI != null
      ? message.sources?.find((s) => s.i === expandedI) ?? null
      : null;

  return (
    <div className="space-y-2">
      {trace.length > 0 && (
        <Trace
          stages={trace}
          doneMs={message.done?.elapsed_ms ?? null}
          isLive={isStreaming && !isDone}
        />
      )}

      {message.agentSteps && message.agentSteps.length > 0 && (
        <AgentTrace steps={message.agentSteps} />
      )}

      {message.agentIterations != null && (
        <div
          className={`rounded-md px-2 py-1 text-[10px] ${
            message.agentHitIterCap
              ? "bg-amber-950/40 text-amber-200 ring-1 ring-amber-900/60"
              : "bg-violet-950/40 text-violet-200 ring-1 ring-violet-900/60"
          }`}
          title="Number of LLM-tools loop iterations the agent used (sum across attempts if reflection retried)"
        >
          {message.agentHitIterCap
            ? `agent hit iteration cap (${message.agentIterations})`
            : `agent · ${message.agentIterations} iteration${
                message.agentIterations === 1 ? "" : "s"
              }`}
          {message.reflectionRetried && " · retried"}
        </div>
      )}

      {message.reflection && (
        <ReflectionChip
          first={message.reflection}
          retry={message.reflectionRetry}
          shippedFirst={message.shippedFirstAnswer}
        />
      )}

      {message.proposals && message.proposals.length > 0 && (
        <ProposalsCard
          proposals={message.proposals}
          onUpdate={onProposalUpdate}
        />
      )}

      {message.rewrite?.was_rewritten && (
        <div
          className="rounded-md bg-cyan-950/40 px-2 py-1 text-[10px] text-cyan-200 ring-1 ring-cyan-900/60"
          title={`Rewritten in ${message.rewrite.elapsed_ms}ms · used to embed the search query, NOT to answer`}
        >
          searched as: <span className="font-mono">{message.rewrite.rewritten}</span>
        </div>
      )}

      {message.rerank?.was_reranked && (
        <div
          className="rounded-md bg-amber-950/40 px-2 py-1 text-[10px] text-amber-200 ring-1 ring-amber-900/60"
          title={`Reranked in ${message.rerank.elapsed_ms}ms · LLM-as-judge reordered the candidates by relevance`}
        >
          reranked {message.rerank.movement.length} candidates · {message.rerank.elapsed_ms}ms
        </div>
      )}
      {message.rerank?.skip_reason && !message.rerank.was_reranked && (
        <div
          className="rounded-md bg-neutral-900/40 px-2 py-1 text-[10px] text-neutral-500 ring-1 ring-neutral-800"
          title="Reranker skipped — saved an LLM call"
        >
          rerank skipped: {message.rerank.skip_reason}
        </div>
      )}

      {message.done && (
        <div className="flex flex-wrap gap-2 text-[10px] text-neutral-500">
          {message.done.prompt_tokens != null && (
            <span>
              {message.done.prompt_tokens}+{message.done.completion_tokens ?? 0} tokens
            </span>
          )}
          {message.done.cost_usd != null && (
            <span>· ${message.done.cost_usd.toFixed(5)}</span>
          )}
        </div>
      )}

      <div className="inline-block max-w-[95%] whitespace-pre-wrap rounded-2xl bg-palace-bg px-3 py-2 text-sm leading-relaxed text-neutral-200 ring-1 ring-palace-edge">
        {message.content ||
          (isStreaming && !isDone ? (
            <span className="text-neutral-500">thinking…</span>
          ) : (
            ""
          ))}
      </div>

      {message.content && isDone && <CopyButton text={message.content} />}

      {message.sources && message.sources.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {message.sources.map((s) => {
              const isExpanded = s.i === expandedI;
              const isNeighbor = s.source === "neighbor";
              return (
                <button
                  key={s.id}
                  onClick={() =>
                    setExpandedI(isExpanded ? null : s.i)
                  }
                  className={[
                    "rounded px-1.5 py-0.5 text-[10px] ring-1 transition",
                    isExpanded
                      ? "bg-palace-accent/30 text-white ring-palace-accent"
                      : isNeighbor
                        ? "bg-palace-bg text-purple-300 ring-purple-900/60 hover:ring-purple-700"
                        : "bg-palace-bg text-neutral-400 ring-palace-edge hover:ring-neutral-500",
                  ].join(" ")}
                  title={
                    isNeighbor
                      ? "From graph expansion (1-hop neighbor)"
                      : "Direct vector match"
                  }
                >
                  [{s.i}]
                  {s.similarity != null && (
                    <span className="ml-1 opacity-70">
                      {(s.similarity * 100).toFixed(0)}%
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {expandedSource && (
            <div className="rounded-lg bg-palace-bg/90 p-3 text-xs leading-relaxed text-neutral-300 ring-1 ring-palace-edge">
              <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wider text-neutral-500">
                <span>source [{expandedSource.i}]</span>
                <span className="text-neutral-700">·</span>
                <span
                  className={
                    expandedSource.source === "neighbor"
                      ? "text-purple-400"
                      : "text-emerald-400"
                  }
                >
                  {expandedSource.source === "neighbor"
                    ? "graph 1-hop"
                    : "direct match"}
                </span>
                {expandedSource.similarity != null && (
                  <>
                    <span className="text-neutral-700">·</span>
                    <span>
                      {(expandedSource.similarity * 100).toFixed(0)}% similar
                    </span>
                  </>
                )}
              </div>
              <div className="whitespace-pre-wrap">
                {expandedSource.preview}
              </div>
            </div>
          )}
        </div>
      )}

      {message.prompt && (
        <div>
          <button
            onClick={() => setShowPrompt(!showPrompt)}
            className="text-[10px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
          >
            {showPrompt ? "▼ hide raw prompt" : "▶ view raw prompt"}
          </button>
          {showPrompt && (
            <div className="mt-1 max-h-80 overflow-auto rounded-lg bg-palace-bg/90 p-3 text-[11px] leading-relaxed text-neutral-300 ring-1 ring-palace-edge">
              <div className="mb-2 text-[9px] uppercase tracking-wider text-neutral-500">
                {message.prompt.model} · temp {message.prompt.temperature}
              </div>
              {message.prompt.messages.map((m, i) => (
                <div key={i} className="mb-2 border-l-2 border-palace-edge pl-2">
                  <div className="text-[9px] font-semibold uppercase tracking-wider text-palace-accent">
                    {m.role}
                  </div>
                  <div className="whitespace-pre-wrap text-neutral-300">
                    {m.content}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Trace({
  stages,
  doneMs,
  isLive,
}: {
  stages: Stage[];
  doneMs: number | null;
  isLive: boolean;
}) {
  return (
    <div className="rounded-lg bg-palace-bg/60 px-3 py-2 text-[11px] ring-1 ring-palace-edge">
      <div className="mb-1 flex items-center justify-between text-neutral-500">
        <span className="font-medium uppercase tracking-wider">Trace</span>
        {doneMs != null ? (
          <span className="text-neutral-600">{(doneMs / 1000).toFixed(2)}s total</span>
        ) : (
          <span className="text-palace-accent">live</span>
        )}
      </div>
      <ol className="space-y-1">
        {stages.map((s, idx) => {
          const isLastStage = idx === stages.length - 1;
          const isRunning = isLive && isLastStage;
          // For finished stages, duration is the next stage's elapsed minus this one's.
          const nextStart = stages[idx + 1]?.elapsed_ms;
          const finishedAt = nextStart ?? doneMs ?? null;
          const duration =
            finishedAt != null && !isRunning ? finishedAt - s.elapsed_ms : null;

          return (
            <li
              key={idx}
              className="flex items-baseline gap-2 text-neutral-400"
            >
              <span className="w-3 shrink-0 text-center">
                {isRunning ? (
                  <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-palace-accent align-middle" />
                ) : (
                  <span className="text-emerald-500">✓</span>
                )}
              </span>
              <span className="flex-1 truncate">{s.label}</span>
              <span className="shrink-0 text-neutral-600">
                {duration != null ? `${duration}ms` : `+${s.elapsed_ms}ms`}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * AgentTrace — renders the LLM-tools loop as a vertical list. Each row is
 * either a tool_call (collapsed args) or its paired tool_result (collapsed
 * preview). Click to expand details. Iteration index is implicit in the
 * order — they arrive in time order from the SSE stream.
 */
function AgentTrace({ steps }: { steps: AgentStep[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // Insert a visual divider when the attempt switches from "first" to "retry".
  // Computed once so we can index into it cheaply during the map.
  const dividerBeforeIdx = (() => {
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1]?.attempt ?? "first";
      const cur = steps[i]?.attempt ?? "first";
      if (prev !== cur) return i;
    }
    return -1;
  })();
  return (
    <div className="space-y-1 rounded-lg bg-palace-bg/40 px-2 py-2 text-[11px] ring-1 ring-palace-edge/60">
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-neutral-500">
        Agent trace · {steps.length} step{steps.length === 1 ? "" : "s"}
      </div>
      {steps.map((s, i) => {
        const key = `${s.tool_call_id}:${s.kind}:${i}`;
        const isExpanded = expanded === key;
        const isCall = s.kind === "tool_call";
        const Icon = isCall ? "🔧" : s.ok ? "↩" : "✗";
        const label = isCall
          ? `${s.name}(${shortArgs(s.args)})`
          : `${s.name} → ${s.ok ? "ok" : "error"} (${s.tool_ms}ms)`;
        return (
          <div key={key}>
            {i === dividerBeforeIdx && (
              <div className="my-1 flex items-center gap-2 text-[9px] uppercase tracking-wider text-amber-500/70">
                <span className="h-px flex-1 bg-amber-900/40" />
                <span>retry attempt</span>
                <span className="h-px flex-1 bg-amber-900/40" />
              </div>
            )}
            <button
              type="button"
              onClick={() => setExpanded(isExpanded ? null : key)}
              className={`flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left transition ${
                isExpanded ? "bg-palace-edge/30" : "hover:bg-palace-edge/15"
              }`}
            >
              <span className="w-3 shrink-0 text-center text-neutral-500">
                {Icon}
              </span>
              <span
                className={`flex-1 truncate ${
                  isCall ? "text-neutral-300" : "text-neutral-400"
                }`}
              >
                {label}
              </span>
              <span className="shrink-0 text-neutral-600">
                +{s.elapsed_ms}ms
              </span>
            </button>
            {isExpanded && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-palace-bg p-2 text-[10px] text-neutral-400">
                {isCall
                  ? JSON.stringify(s.args, null, 2)
                  : s.result_preview || "(empty)"}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * CopyButton — small affordance under the assistant bubble. Copies the
 * full answer text to the clipboard. Brief inline confirmation; no toast,
 * no global state. Hidden on mobile-keyboard focus to avoid jitter.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function onClick() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked (e.g. http context). Fall back silently —
      // the user can still select+copy from the bubble.
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 self-start rounded px-1.5 py-0.5 text-[10px] text-neutral-500 transition hover:bg-palace-bg/60 hover:text-neutral-300"
      title={copied ? "Copied!" : "Copy answer to clipboard"}
    >
      <span aria-hidden="true">{copied ? "✓" : "📋"}</span>
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}

/**
 * ProposalsCard — rendered when the agent queued one or more write proposals.
 * Each row shows the action's payload (title + content preview + reason)
 * with [Approve] [Reject] buttons. On click, calls the corresponding
 * endpoint and updates local UI state via onUpdate. After successful
 * approval, also refreshes the graph store so the new node + edges
 * appear in the canvas immediately.
 *
 * No undo button — the user can delete the created node via the sidebar
 * if they change their mind. Audit row in agent_actions stays around.
 */
function ProposalsCard({
  proposals,
  onUpdate,
}: {
  proposals: AgentProposal[];
  onUpdate: (id: string, patch: Partial<AgentProposal>) => void;
}) {
  const workspaceId = useGraphStore((s) => s.workspaceId);
  const applyClusters = useGraphStore((s) => s.applyClusters);
  const setEdges = useGraphStore((s) => s.setEdges);

  /** After approval: refresh nodes + edges immediately (cheap), then kick
   *  off cluster recompute in the background (slower; ~1s for the LLM
   *  naming on the changed cluster). Done as a fire-and-forget chain so
   *  the approve button transitions to "✓ created" without waiting on
   *  clustering — the legend updates a beat later. */
  async function refreshGraphAndRecluster() {
    if (!workspaceId) return;
    // Immediate: nodes + edges (server already ran rebuild_semantic_edges
    // inside the approve handler).
    try {
      const [nodes, edges] = await Promise.all([
        db.listNodes(workspaceId),
        db.listEdges(workspaceId),
      ]);
      const clusters = await db.listClusters(workspaceId);
      applyClusters(nodes, clusters);
      setEdges(edges);
    } catch {
      // Non-fatal — the canvas will catch up on next page load.
      return;
    }
    // Background: recompute clusters. Members_hash reuse keeps cost
    // bounded (~$0.0001 for the 1-2 changed clusters).
    try {
      await api(`/workspaces/${workspaceId}/recompute-clusters`, {
        method: "POST",
      });
      const [nodes, clusters] = await Promise.all([
        db.listNodes(workspaceId),
        db.listClusters(workspaceId),
      ]);
      applyClusters(nodes, clusters);
    } catch {
      // Cluster recompute failure is non-fatal; user can click
      // Recompute Topics manually.
    }
  }

  async function approve(id: string) {
    onUpdate(id, { uiStatus: "approving" });
    try {
      const res = await api<{ id: string; status: string; result_node_id?: string }>(
        `/agent/proposals/${id}/approve`,
        { method: "POST" },
      );
      onUpdate(id, {
        uiStatus: "approved",
        resultNodeId: res.result_node_id ?? null,
      });
      await refreshGraphAndRecluster();
    } catch (e) {
      onUpdate(id, {
        uiStatus: "error",
        errorDetail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async function reject(id: string) {
    onUpdate(id, { uiStatus: "rejecting" });
    try {
      await api(`/agent/proposals/${id}/reject`, { method: "POST" });
      onUpdate(id, { uiStatus: "rejected" });
    } catch (e) {
      onUpdate(id, {
        uiStatus: "error",
        errorDetail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="space-y-2 rounded-lg bg-violet-950/30 px-3 py-2 ring-1 ring-violet-900/60">
      <div className="text-[9px] font-semibold uppercase tracking-wider text-violet-300">
        🪄 Agent proposes {proposals.length} write{proposals.length === 1 ? "" : "s"} — your approval required
      </div>
      {proposals.map((p) => (
        <ProposalRow
          key={p.id}
          proposal={p}
          onApprove={() => approve(p.id)}
          onReject={() => reject(p.id)}
        />
      ))}
    </div>
  );
}

function ProposalRow({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: AgentProposal;
  onApprove: () => void;
  onReject: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceCount = proposal.payload.source_node_ids?.length ?? 0;
  const status = proposal.uiStatus ?? "pending";
  const disabled =
    status === "approving" ||
    status === "rejecting" ||
    status === "approved" ||
    status === "rejected";

  const statusBadge =
    status === "approved" ? (
      <span className="text-[10px] text-emerald-400">
        ✓ created{proposal.resultNodeId ? "" : ""}
      </span>
    ) : status === "rejected" ? (
      <span className="text-[10px] text-neutral-500">rejected</span>
    ) : status === "approving" || status === "rejecting" ? (
      <span className="text-[10px] text-neutral-400">{status}…</span>
    ) : status === "error" ? (
      <span className="text-[10px] text-red-400">error</span>
    ) : null;

  return (
    <div className="rounded bg-palace-bg/60 px-2 py-1.5 text-[11px]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="truncate">
          <span className="text-violet-300">create_summary_node</span>
          <span className="ml-2 text-neutral-200">
            {proposal.payload.title || "(untitled)"}
          </span>
          {sourceCount > 0 && (
            <span className="ml-1 text-neutral-500">· {sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
          )}
        </span>
        <span className="ml-2 shrink-0 opacity-60">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 text-[10px] text-neutral-400">
          {proposal.reason && (
            <div>
              <span className="text-neutral-500">why:</span> {proposal.reason}
            </div>
          )}
          {proposal.payload.content && (
            <div className="whitespace-pre-wrap rounded bg-palace-bg p-2 text-neutral-300">
              {proposal.payload.content.slice(0, 600)}
              {proposal.payload.content.length > 600 && "…"}
            </div>
          )}
          {proposal.errorDetail && (
            <div className="text-red-400">{proposal.errorDetail}</div>
          )}
        </div>
      )}
      <div className="mt-1.5 flex items-center justify-between">
        {statusBadge ?? <span />}
        {status === "pending" && (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={onReject}
              disabled={disabled}
              className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700 disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={disabled}
              className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              Approve
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function shortArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      const short = s.length > 30 ? s.slice(0, 29) + "…" : s;
      return `${k}: ${short}`;
    })
    .join(", ");
}

function scoreTier(score: number): string {
  return score >= 5
    ? "bg-emerald-950/40 text-emerald-200 ring-emerald-900/60"
    : score >= 4
      ? "bg-lime-950/40 text-lime-200 ring-lime-900/60"
      : score >= 3
        ? "bg-amber-950/40 text-amber-200 ring-amber-900/60"
        : score >= 2
          ? "bg-orange-950/40 text-orange-200 ring-orange-900/60"
          : "bg-red-950/40 text-red-200 ring-red-900/60";
}

/**
 * ReflectionChip — surfaces the judge's score on the SHIPPED answer, with
 * the first-attempt score as expandable detail when retry happened.
 *
 *   no retry:               "✓ judge 5/5"
 *   retry → improvement:    "✓ judge 5/5 (was 2/5, retried)"
 *   retry → regression:     "⚠ judge 2/5 (retry scored 1/5 — kept first)"
 *   retry pending mid-stream: "🔄 judge 2/5 — retrying with feedback"
 */
function ReflectionChip({
  first,
  retry,
  shippedFirst,
}: {
  first: ReflectionInfo;
  retry?: ReflectionInfo;
  shippedFirst?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Determine the *shipped* score + which issues are relevant.
  const shipped = retry
    ? shippedFirst
      ? first.score
      : Math.max(first.score, retry.score)
    : first.score;
  const issues = retry
    ? shippedFirst
      ? retry.issues // why we rejected the retry
      : first.issues // why we retried in the first place
    : first.issues;
  const tier = scoreTier(shipped);
  const icon = shipped >= 4 ? "✓" : first.retrying && !retry ? "🔄" : "⚠";

  let headline: string;
  if (retry) {
    if (shippedFirst) {
      headline = `judge ${first.score}/5 (retry scored ${retry.score}/5 — kept first)`;
    } else if (retry.score > first.score) {
      headline = `judge ${retry.score}/5 (was ${first.score}/5, retried)`;
    } else {
      headline = `judge ${retry.score}/5 (tied with first ${first.score}/5)`;
    }
  } else if (first.retrying) {
    headline = `judge ${first.score}/5 — retrying with feedback`;
  } else {
    headline = `judge ${first.score}/5`;
  }

  return (
    <div className={`rounded-md px-2 py-1 text-[10px] ring-1 ${tier}`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between"
        title={`Judged in ${first.elapsed_ms}ms${retry ? ` · retry judged in ${retry.elapsed_ms}ms` : ""}`}
      >
        <span>
          {icon} {headline}
        </span>
        {issues && <span className="opacity-60">{expanded ? "▼" : "▶"}</span>}
      </button>
      {expanded && issues && (
        <div className="mt-1 whitespace-pre-wrap text-[10px] opacity-80">
          {issues}
        </div>
      )}
    </div>
  );
}
