import { useState, useEffect } from "react";
import { Lang } from "./useJudge";

// ─── Types mirroring the Go ProblemResponse ───────────────────────────────────

export interface ProblemMeta {
  title: string;
  difficulty: number; // 1 = Easy, 2 = Medium, 3 = Hard
  tags: string[];
  time_limit_seconds: number;
  memory_limit_mb: number;
}

export interface ProblemData {
  id: string;
  meta: ProblemMeta;
  description: string;        // raw Markdown
  starter_code: Record<Lang, string>;
}

interface UseProblemResult {
  problem: ProblemData | null;
  loading: boolean;
  error: string | null;
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

export function useProblem(id: string): UseProblemResult {
  const [problem, setProblem] = useState<ProblemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetch(`${API_BASE}/problem/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ProblemData>;
      })
      .then((data) => {
        if (!cancelled) {
          setProblem(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(String(err));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return { problem, loading, error };
}

/** Map numeric difficulty → display label */
export function difficultyLabel(d: number): string {
  if (d <= 1) return "Easy";
  if (d === 2) return "Medium";
  return "Hard";
}
