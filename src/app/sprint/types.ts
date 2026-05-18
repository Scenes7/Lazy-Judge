import { Lang, StatusKind } from "../hooks/useJudge";
import { ProblemData } from "../hooks/useProblem";

export type Phase = "intro" | "transition" | "sprint" | "results";

export interface SlotState {
  problem: ProblemData;
  lang: Lang;
  code: string;
  verdict: StatusKind | null; // null=pending after submit, undefined=not yet submitted
  submitted: boolean;
}

export type { Lang, StatusKind, ProblemData };
