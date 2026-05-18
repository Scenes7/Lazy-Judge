import { useCallback, useRef } from "react";
import { Lang, StatusKind } from "./useJudge";
import { ProblemData } from "./useProblem";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlotVerdict {
  kind: StatusKind;
  message: string;
  output?: string;
  detail?: string;
}

export interface SubmitPayload {
  lang: Lang;
  code: string;
  problem_id: string;
  problem_title?: string;
  /** Sprint-mode metadata — omitted for intro submissions. */
  sprint_id?: string;
  sprint_size?: number;
  slot_index?: number;
  /** Milliseconds the user spent on this problem (from problemStartTime ref). */
  problem_ms?: number;
}

const TERMINAL_STATUSES = new Set<StatusKind>([
  "success", "error", "wrong_answer", "compile_error", "runtime_error", "tle", "mle",
]);

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useSprintJudge handles rapid, overlapping submissions for N problem slots.
 * Each submit() call fires-and-forgets — it opens its own WebSocket keyed by
 * slot index and calls onVerdict(slotIndex, verdict) when the judge responds.
 * WebSockets for different slots are fully independent; submitting a new
 * problem never interrupts a pending verdict for a previous one.
 */
export function useSprintJudge() {
  // Map<slotIndex, WebSocket> — keeps the live connection per slot
  const wsMap = useRef<Map<number, WebSocket>>(new Map());

  /**
   * Submit code for `slotIndex`. Fires the POST immediately, then opens a WS
   * to stream the verdict. Calls onVerdict exactly once per submission.
   */
  const submit = useCallback(async (
    slotIndex: number,
    payload: SubmitPayload,
    onVerdict: (slot: number, verdict: SlotVerdict) => void,
  ) => {
    // Close any previous WS on this slot (re-submit case)
    wsMap.current.get(slotIndex)?.close();

    try {
      const res = await fetch(`${API_BASE}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429) {
        onVerdict(slotIndex, { kind: "error", message: "Rate Limited", detail: "Too many requests — please slow down." });
        return;
      }

      if (!res.ok) {
        const text = await res.text();
        onVerdict(slotIndex, { kind: "error", message: "Submission rejected", detail: text });
        return;
      }

      const { submission_id } = (await res.json()) as { submission_id: string };
      const wsUrl = `${API_BASE.replace(/^http/, "ws")}/ws/results?id=${submission_id}`;
      const ws = new WebSocket(wsUrl);
      wsMap.current.set(slotIndex, ws);

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as {
            status: string; message?: string; output?: string; detail?: string;
          };
          const rawKind = msg.status as StatusKind;
          const kind: StatusKind =
            TERMINAL_STATUSES.has(rawKind) || rawKind === "queued" || rawKind === "running"
              ? rawKind : "error";

          if (TERMINAL_STATUSES.has(kind)) {
            ws.close();
            wsMap.current.delete(slotIndex);
            onVerdict(slotIndex, {
              kind, message: msg.message ?? msg.status,
              output: msg.output, detail: msg.detail,
            });
          }
        } catch { /* ignore non-JSON frames */ }
      };

      ws.onerror = () => {
        onVerdict(slotIndex, { kind: "error", message: "WebSocket error", detail: "Lost connection to judge" });
      };

      ws.onclose = (ev) => {
        if (ev.code !== 1000 && ev.code !== 1001) {
          onVerdict(slotIndex, { kind: "error", message: "Connection lost", detail: `Code ${ev.code}` });
        }
      };

    } catch (err) {
      onVerdict(slotIndex, { kind: "error", message: "Network error", detail: String(err) });
    }
  }, []);

  /** Close all open WebSockets (called on unmount / session reset). */
  const closeAll = useCallback(() => {
    for (const ws of wsMap.current.values()) ws.close();
    wsMap.current.clear();
  }, []);

  return { submit, closeAll };
}

export async function fetchRandomProblems(count: number): Promise<ProblemData[]> {
  const res = await fetch(`${API_BASE}/api/problems/random?count=${count}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ProblemData[]>;
}
