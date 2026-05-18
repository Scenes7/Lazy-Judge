import { useState, useRef, useCallback } from "react";

// ─── Shared Contract ────────────────────────────────────────────────────────
export type Lang = "python" | "cpp";

export interface SubmitPayload {
  lang: Lang;
  code: string;
  problem_id: string;
}

// ─── Status Machine ─────────────────────────────────────────────────────────
/** All statuses the judge backend can emit. */
export type StatusKind =
  | "idle"
  | "queued"
  | "running"
  | "success"
  // ── verdict statuses (all map to the "error" visual style) ──
  | "error"
  | "wrong_answer"
  | "compile_error"
  | "runtime_error"
  | "tle"
  | "mle";

/** The set of statuses that represent a terminal (non-transient) state. */
const TERMINAL_STATUSES = new Set<StatusKind>([
  "success",
  "error",
  "wrong_answer",
  "compile_error",
  "runtime_error",
  "tle",
  "mle",
]);

export interface SubmissionStatus {
  kind: StatusKind;
  /** Human-readable message */
  message: string;
  /** Output / stdout from the judge */
  output?: string;
  /** Exit code or error detail */
  detail?: string;
  /** Elapsed ms (populated on terminal states) */
  elapsedMs?: number;
}

const IDLE: SubmissionStatus = { kind: "idle", message: "Ready" };

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

// ─── Hook ────────────────────────────────────────────────────────────────────
export function useJudge() {
  const [status, setStatus] = useState<SubmissionStatus>(IDLE);
  const wsRef = useRef<WebSocket | null>(null);
  const startRef = useRef<number>(0);

  const reset = useCallback(() => {
    wsRef.current?.close();
    setStatus(IDLE);
  }, []);

  const submit = useCallback(async (payload: SubmitPayload) => {
    // Clean up any previous WS
    wsRef.current?.close();
    setStatus({ kind: "queued", message: "Queuing submission…" });
    startRef.current = performance.now();

    try {
      // 1️⃣  POST /submit  — returns { submission_id }
      const res = await fetch(`${API_BASE}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        setStatus({
          kind: "error",
          message: "Rate Limited",
          detail: "Too many requests — please slow down.",
          elapsedMs: Math.round(performance.now() - startRef.current),
        });
        return;
      }

      if (!res.ok) {
        const text = await res.text();
        setStatus({
          kind: "error",
          message: "Submission rejected",
          detail: text,
          elapsedMs: Math.round(performance.now() - startRef.current),
        });
        return;
      }

      const { submission_id } = (await res.json()) as {
        submission_id: string;
      };

      // 2️⃣  Open WS  /ws/results?id=<submission_id>
      const wsUrl = `${API_BASE.replace(/^http/, "ws")}/ws/results?id=${submission_id}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            status: string;
            message?: string;
            output?: string;
            detail?: string;
          };

          // Normalise: any unrecognised status string → "error"
          const rawKind = msg.status as StatusKind;
          const kind: StatusKind = TERMINAL_STATUSES.has(rawKind) || rawKind === "queued" || rawKind === "running"
            ? rawKind
            : "error";

          const isTerminal = TERMINAL_STATUSES.has(kind);

          setStatus({
            kind,
            message: msg.message ?? msg.status,
            output: msg.output,
            detail: msg.detail,
            elapsedMs: isTerminal
              ? Math.round(performance.now() - startRef.current)
              : undefined,
          });

          if (isTerminal) ws.close();
        } catch {
          // non-JSON ping frames — ignore
        }
      };

      ws.onerror = () => {
        setStatus({
          kind: "error",
          message: "WebSocket error",
          detail: "Lost connection to judge service",
          elapsedMs: Math.round(performance.now() - startRef.current),
        });
      };

      ws.onclose = (ev) => {
        // Closed unexpectedly while still running
        if (ev.code !== 1000 && ev.code !== 1001) {
          setStatus((prev) =>
            prev.kind === "running" || prev.kind === "queued"
              ? {
                kind: "error",
                message: "Connection closed unexpectedly",
                detail: `Code ${ev.code}`,
                elapsedMs: Math.round(performance.now() - startRef.current),
              }
              : prev
          );
        }
      };
    } catch (err) {
      setStatus({
        kind: "error",
        message: "Network error",
        detail: String(err),
        elapsedMs: Math.round(performance.now() - startRef.current),
      });
    }
  }, []);

  return { status, submit, reset };
}
