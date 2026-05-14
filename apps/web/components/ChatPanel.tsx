"use client";

import { useEffect, useRef, useState } from "react";

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

type DoneInfo = {
  elapsed_ms: number;
  embed_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  cost_usd?: number;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  trace?: Stage[];
  prompt?: PromptInfo;
  done?: DoneInfo;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
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
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ question: q, k: 5, history }),
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
    } else if (event === "done" && payload && typeof payload === "object") {
      markDone(payload as DoneInfo);
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
            />
          ),
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-palace-edge p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          placeholder="What's in your memory?"
          className="w-full rounded-lg bg-palace-bg px-3 py-2 text-sm outline-none ring-1 ring-palace-edge focus:ring-palace-accent disabled:opacity-50"
        />
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
}: {
  message: Message;
  isStreaming: boolean;
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
