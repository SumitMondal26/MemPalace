"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type ChatLog = {
  id: string;
  created_at: string;
  question: string;
  answer: string | null;
  prompt_messages: { role: string; content: string }[];
  cited_node_ids: string[] | null;
  model: string | null;
  embed_model: string | null;
  retrieval_strategy: string | null;
  k_requested: number | null;
  k_returned_raw: number | null;
  k_returned_filtered: number | null;
  similarity_min: number | null;
  similarity_max: number | null;
  history_size: number | null;
  embed_ms: number | null;
  search_ms: number | null;
  llm_ms: number | null;
  total_ms: number | null;
  embed_tokens: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number | null;
  status: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  success: "text-emerald-400",
  empty_context: "text-amber-400",
  failed: "text-red-400",
};

export default function InsightsClient({
  userEmail,
  logs,
}: {
  userEmail: string;
  logs: ChatLog[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    logs[0]?.id ?? null,
  );
  const selected = logs.find((l) => l.id === selectedId);

  // Aggregates over the loaded set.
  const stats = useMemo(() => {
    if (logs.length === 0) {
      return {
        count: 0,
        totalCost: 0,
        avgLatency: 0,
        p95Latency: 0,
        totalTokens: 0,
        emptyContextRate: 0,
        avgEmbedMs: 0,
        avgSearchMs: 0,
        avgLlmMs: 0,
      };
    }
    const totalCost = logs.reduce((s, l) => s + (l.cost_usd ?? 0), 0);
    const totalTokens = logs.reduce(
      (s, l) =>
        s +
        (l.embed_tokens ?? 0) +
        (l.prompt_tokens ?? 0) +
        (l.completion_tokens ?? 0),
      0,
    );
    const latencies = logs
      .map((l) => l.total_ms ?? 0)
      .sort((a, b) => a - b);
    const avgLatency =
      latencies.reduce((s, x) => s + x, 0) / latencies.length;
    const p95Idx = Math.floor(latencies.length * 0.95);
    const p95Latency = latencies[Math.min(p95Idx, latencies.length - 1)];
    const emptyCount = logs.filter((l) => l.status === "empty_context").length;
    const avgOf = (key: keyof ChatLog) => {
      const vals = logs.map((l) => (l[key] as number) ?? 0);
      return vals.reduce((s, x) => s + x, 0) / vals.length;
    };
    return {
      count: logs.length,
      totalCost,
      avgLatency,
      p95Latency,
      totalTokens,
      emptyContextRate: emptyCount / logs.length,
      avgEmbedMs: avgOf("embed_ms"),
      avgSearchMs: avgOf("search_ms"),
      avgLlmMs: avgOf("llm_ms"),
    };
  }, [logs]);

  return (
    <div className="min-h-screen bg-palace-bg text-neutral-100">
      <header className="flex items-center justify-between border-b border-palace-edge px-6 py-3">
        <div>
          <h1 className="text-base font-semibold">Insights</h1>
          <p className="text-xs text-neutral-500">
            {userEmail} · {logs.length} chat turn{logs.length === 1 ? "" : "s"} loaded
          </p>
        </div>
        <Link
          href="/graph"
          className="rounded-lg px-3 py-1 text-xs text-neutral-400 ring-1 ring-palace-edge hover:bg-palace-panel hover:text-neutral-100"
        >
          ← back to graph
        </Link>
      </header>

      {/* Aggregate cards */}
      <section className="grid grid-cols-2 gap-3 p-6 md:grid-cols-4">
        <Stat
          label="Requests"
          value={stats.count.toString()}
          sub="loaded set"
        />
        <Stat
          label="Total cost"
          value={`$${stats.totalCost.toFixed(4)}`}
          sub={`${stats.totalTokens.toLocaleString()} tokens`}
        />
        <Stat
          label="Avg latency"
          value={`${(stats.avgLatency / 1000).toFixed(2)}s`}
          sub={`p95 ${(stats.p95Latency / 1000).toFixed(2)}s`}
        />
        <Stat
          label="Empty-context rate"
          value={`${(stats.emptyContextRate * 100).toFixed(0)}%`}
          sub={`${logs.filter((l) => l.status === "empty_context").length} / ${stats.count}`}
        />
      </section>

      {/* Stage breakdown bar */}
      <section className="px-6 pb-2">
        <div className="rounded-lg bg-palace-panel/50 p-3 ring-1 ring-palace-edge">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Average time spent per stage
          </div>
          <StageBar
            embed={stats.avgEmbedMs}
            search={stats.avgSearchMs}
            llm={stats.avgLlmMs}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 p-6 md:grid-cols-[2fr_3fr]">
        {/* Recent requests table */}
        <section className="space-y-1 rounded-lg bg-palace-panel/30 p-2 ring-1 ring-palace-edge">
          <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Recent requests
          </div>
          {logs.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-neutral-500">
              No chat turns logged yet. Ask something on /graph and come back.
            </div>
          )}
          <div className="max-h-[60vh] space-y-1 overflow-y-auto">
            {logs.map((l) => (
              <button
                key={l.id}
                onClick={() => setSelectedId(l.id)}
                className={[
                  "w-full rounded-md px-3 py-2 text-left text-xs transition",
                  l.id === selectedId
                    ? "bg-palace-accent/20 ring-1 ring-palace-accent/40"
                    : "hover:bg-palace-bg",
                ].join(" ")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium text-neutral-200">
                    {l.question}
                  </span>
                  <span
                    className={`shrink-0 text-[10px] ${
                      STATUS_COLORS[l.status ?? "success"] ?? ""
                    }`}
                  >
                    {l.status}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-500">
                  <span>{(l.total_ms ?? 0)}ms</span>
                  <span>·</span>
                  <span>${(l.cost_usd ?? 0).toFixed(5)}</span>
                  <span>·</span>
                  <span>
                    {(l.prompt_tokens ?? 0) + (l.completion_tokens ?? 0)} tok
                  </span>
                  <span>·</span>
                  <span>{new Date(l.created_at).toLocaleTimeString()}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Drill-down */}
        <section className="space-y-3">
          {selected ? (
            <DrillDown log={selected} />
          ) : (
            <div className="rounded-lg bg-palace-panel/30 p-6 text-center text-xs text-neutral-500 ring-1 ring-palace-edge">
              Select a request to inspect.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg bg-palace-panel/50 p-3 ring-1 ring-palace-edge">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-neutral-100">{value}</div>
      {sub && <div className="text-[10px] text-neutral-500">{sub}</div>}
    </div>
  );
}

function StageBar({
  embed,
  search,
  llm,
}: {
  embed: number;
  search: number;
  llm: number;
}) {
  const total = embed + search + llm || 1;
  const pct = (n: number) => (n / total) * 100;
  return (
    <div className="space-y-1">
      <div className="flex h-3 overflow-hidden rounded">
        <div
          className="bg-cyan-500/80"
          style={{ width: `${pct(embed)}%` }}
          title={`Embed ${embed.toFixed(0)}ms`}
        />
        <div
          className="bg-emerald-500/80"
          style={{ width: `${pct(search)}%` }}
          title={`Search ${search.toFixed(0)}ms`}
        />
        <div
          className="bg-amber-500/80"
          style={{ width: `${pct(llm)}%` }}
          title={`LLM ${llm.toFixed(0)}ms`}
        />
      </div>
      <div className="flex flex-wrap gap-3 text-[10px] text-neutral-400">
        <Legend color="bg-cyan-500" label={`Embed ${embed.toFixed(0)}ms`} />
        <Legend color="bg-emerald-500" label={`Search ${search.toFixed(0)}ms`} />
        <Legend color="bg-amber-500" label={`LLM ${llm.toFixed(0)}ms`} />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded ${color}`} />
      <span>{label}</span>
    </span>
  );
}

function DrillDown({ log }: { log: ChatLog }) {
  return (
    <div className="space-y-3">
      {/* Q + A */}
      <div className="rounded-lg bg-palace-panel/50 p-4 ring-1 ring-palace-edge">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Question
        </div>
        <div className="mt-1 text-sm text-neutral-100">{log.question}</div>
        <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Answer
        </div>
        <div className="mt-1 whitespace-pre-wrap text-sm text-neutral-300">
          {log.answer || "(empty)"}
        </div>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 rounded-lg bg-palace-panel/50 p-4 ring-1 ring-palace-edge md:grid-cols-3">
        <Meta label="Status" value={log.status ?? "?"} />
        <Meta label="Model" value={log.model ?? "?"} />
        <Meta label="Embed model" value={log.embed_model ?? "?"} />
        <Meta label="Retrieval" value={log.retrieval_strategy ?? "?"} />
        <Meta
          label="Chunks (filtered/raw)"
          value={`${log.k_returned_filtered ?? 0} / ${log.k_returned_raw ?? 0}`}
        />
        <Meta label="History size" value={`${log.history_size ?? 0}`} />
        <Meta
          label="Similarity range"
          value={
            log.similarity_min != null && log.similarity_max != null
              ? `${log.similarity_min.toFixed(3)} – ${log.similarity_max.toFixed(3)}`
              : "—"
          }
        />
        <Meta
          label="Total time"
          value={`${((log.total_ms ?? 0) / 1000).toFixed(2)}s`}
        />
        <Meta label="Cost" value={`$${(log.cost_usd ?? 0).toFixed(6)}`} />
        <Meta label="Embed tokens" value={`${log.embed_tokens ?? 0}`} />
        <Meta label="Prompt tokens" value={`${log.prompt_tokens ?? 0}`} />
        <Meta
          label="Completion tokens"
          value={`${log.completion_tokens ?? 0}`}
        />
      </div>

      {/* Per-stage timing breakdown */}
      <div className="rounded-lg bg-palace-panel/50 p-4 ring-1 ring-palace-edge">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Stage timings
        </div>
        <StageBar
          embed={log.embed_ms ?? 0}
          search={log.search_ms ?? 0}
          llm={log.llm_ms ?? 0}
        />
      </div>

      {/* Raw prompt */}
      <details className="rounded-lg bg-palace-panel/50 p-4 ring-1 ring-palace-edge">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          Raw prompt sent to OpenAI ({log.prompt_messages?.length ?? 0} messages)
        </summary>
        <div className="mt-3 max-h-96 overflow-auto space-y-2 text-[11px] leading-relaxed text-neutral-300">
          {log.prompt_messages?.map((m, i) => (
            <div key={i} className="border-l-2 border-palace-edge pl-2">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-palace-accent">
                {m.role}
              </div>
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="mt-0.5 text-xs text-neutral-200">{value}</div>
    </div>
  );
}
