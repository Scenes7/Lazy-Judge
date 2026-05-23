"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Zap, Loader2, ChevronDown, House, Settings, CircleHelp } from "lucide-react";
import { useJudge, Lang, StatusKind } from "./hooks/useJudge";
import { useProblem, ProblemData, difficultyLabel } from "./hooks/useProblem";
import { useSprintJudge, fetchRandomProblems } from "./hooks/useSprintJudge";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="shimmer" style={{ flex: 1 }} />,
});

const SPRINT_OPTIONS = [1, 3, 5, 10] as const;
const MAX_CODE_LEN = 1000;

const EDITOR_FONTS: { label: string; css: string }[] = [
  { label: "Roboto Mono", css: "'Roboto Mono', monospace" },
  { label: "Roboto", css: "'Roboto', sans-serif" },
  { label: "Calibri", css: "'Calibri', sans-serif" },
  { label: "Futura", css: "'Futura', 'Century Gothic', sans-serif" },
  { label: "Source Code Pro", css: "'Source Code Pro', monospace" },
  { label: "Comic Sans", css: "'Comic Sans MS', cursive" },
];

const LANG_META: Record<Lang, { label: string; monacoLang: string }> = {
  python: { label: "Python 3", monacoLang: "python" },
  cpp: { label: "C++ 17", monacoLang: "cpp" },
};

type Phase = "intro" | "transition" | "sprint" | "results";
type SlotStatus = "future" | "active" | "pending" | "accepted" | "rejected";

interface Slot {
  problem: ProblemData;
  lang: Lang;
  /** Per-language editor content. Reset to starter code when a new problem is loaded. */
  codeByLang: Partial<Record<Lang, string>>;
  status: SlotStatus;
  verdict: StatusKind | null;
  /** Human-readable verdict message from the judge (e.g. "Wrong Answer", "TLE") */
  verdictMessage: string | null;
  submittedCode: string;
  /** Milliseconds from problem-display to submission click */
  submitMs: number | null;
  /** Characters typed beyond the starter code (non-whitespace) */
  extraChars: number | null;
  /** WPM for this individual problem */
  slotWpm: number | null;
}

function nonWs(s: string) { return s.replace(/\s/g, "").length; }

function slotColor(s: SlotStatus): string {
  switch (s) {
    case "active": return "#388bfd";
    case "pending": return "#6e7681";
    case "accepted": return "#3fb950";
    case "rejected": return "#f85149";
    default: return "#e6edf3"; // future → white/light
  }
}

// ── Sidebar rectangle used in both sprint and results views ──────────────────
function SlotRect({
  status, idx, enlarged = false,
}: {
  status: SlotStatus; idx: number; enlarged?: boolean;
}) {
  const bg = slotColor(status);
  const isActive = status === "active";
  return (
    <div
      className={isActive ? "slot-active-pulse" : ""}
      style={{
        width: enlarged ? 72 : "100%",
        height: enlarged ? 88 : 44,
        borderRadius: enlarged ? 12 : 8,
        background: bg,
        // subtle inset border so white "future" rects have an edge
        boxShadow: status === "future"
          ? "inset 0 0 0 1px rgba(255,255,255,0.18)"
          : isActive
            ? `0 0 14px ${bg}80`
            : "none",
        transition: "background 0.35s ease, box-shadow 0.35s ease",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: status === "future" ? "var(--bg-primary)" : "#fff",
        fontSize: enlarged ? 22 : 14,
        fontWeight: 700,
      }}
    >
      {status === "accepted" && "✓"}
      {status === "rejected" && "✗"}
      {status === "pending" && <Loader2 size={enlarged ? 20 : 13} className="animate-spin" />}
      {(status === "future" || status === "active") && (idx + 1)}
    </div>
  );
}

// ── Right-side sprint sidebar ─────────────────────────────────────────────────
function SprintSidebar({ slots }: { slots: Slot[] }) {
  return (
    <div style={{
      width: 64,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      justifyContent: "center",
      gap: 10,
      padding: "16px 10px",
      background: "var(--bg-secondary)",
      borderLeft: "1px solid var(--border-subtle)",
    }}>
      {slots.map((s, i) => (
        <SlotRect key={i} status={s.status} idx={i} />
      ))}
    </div>
  );
}

const MD_STYLES = `
.md-body{color:var(--text-secondary);font-size:13px;line-height:1.7}
.md-body h1,.md-body h2,.md-body h3{color:var(--text-primary);font-weight:700;margin:1em 0 .4em}
.md-body h1{font-size:1.15em}.md-body h2{font-size:1em}.md-body h3{font-size:.95em}
.md-body p{margin:0 0 .75em}
.md-body strong{color:var(--text-primary);font-weight:600}
.md-body code{background:var(--bg-tertiary);border:1px solid var(--border-subtle);border-radius:3px;padding:1px 4px;font-size:11px;font-family:monospace;color:var(--accent-purple)}
.md-body pre{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:6px;padding:10px 12px;overflow-x:auto;margin:0 0 .75em}
.md-body pre code{background:none;border:none;padding:0;color:var(--text-primary)}
.md-body ul,.md-body ol{padding-left:1.3em;margin:0 0 .75em}
.md-body li{margin-bottom:.2em}
/* results accordion */
.result-row{cursor:pointer;user-select:none;transition:filter 0.15s}
.result-row:hover{filter:brightness(1.08)}
.result-code{
  overflow:hidden;
  transition:max-height 0.32s cubic-bezier(0.4,0,0.2,1),
             opacity    0.25s ease;
}
.result-code.open{max-height:600px;opacity:1}
.result-code.closed{max-height:0;opacity:0}
.result-chevron{transition:transform 0.25s ease}
.result-chevron.open{transform:rotate(180deg)}
`;

// ── Single accordion problem row ──────────────────────────────────────────────────────
function ResultRow({ slot, idx, open, onToggle }: {
  slot: Slot;
  idx: number;
  open: boolean;
  onToggle: () => void;
}) {
  const statusColor = slotColor(slot.status);

  // Map StatusKind → short display label
  const kindLabel: Partial<Record<StatusKind, string>> = {
    success: "AC",
    wrong_answer: "WA",
    compile_error: "CE",
    runtime_error: "RTE",
    tle: "TLE",
    mle: "MLE",
    error: "Error",
  };

  function badgeText(): string {
    if (slot.status === "accepted") return "AC";
    if (slot.status === "pending") return "running";
    if (slot.status === "active" || slot.status === "future") return "—";
    if (slot.verdict) return kindLabel[slot.verdict] ?? slot.verdictMessage ?? "Error";
    return slot.verdictMessage ?? "Error";
  }

  // Badge gets the actual status color as its background
  const badgeBg = slot.status === "future" || slot.status === "active"
    ? "var(--bg-tertiary)"
    : statusColor;
  const badgeColor = slot.status === "future" || slot.status === "active"
    ? "var(--text-muted)"
    : "#fff";

  return (
    <div style={{ borderRadius: 10, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.25)" }}>
      {/* Header row */}
      <div
        className="result-row"
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 14,
          padding: "14px 18px",
          background: "var(--bg-secondary)",
          color: "var(--text-primary)",
        }}
      >
        {/* Number bubble */}
        <div style={{
          width: 28, height: 28, borderRadius: "50%",
          background: "var(--bg-tertiary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 12, fontWeight: 700, flexShrink: 0,
          color: "var(--text-secondary)",
        }}>
          {idx + 1}
        </div>

        {/* Title */}
        <span style={{ flex: 1, fontWeight: 600, fontSize: 14, letterSpacing: "-0.01em" }}>
          {slot.problem.meta.title}
        </span>

        {/* Problem-level stats: Time / Chars / WPM — only when submitted */}
        {slot.submitMs !== null && (
          <div style={{ display: "flex", gap: 18, alignItems: "center", flexShrink: 0 }}>
            {([
              { val: (() => { const s = Math.floor((slot.submitMs ?? 0) / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; })(), label: "Time" },
              { val: String(slot.extraChars ?? 0), label: "Chars" },
              { val: String(Math.max(0, slot.slotWpm ?? 0)), label: "WPM" },
            ]).map(({ val, label }) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)" }}>{val}</div>
                <div style={{ fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginTop: 2 }}>{label}</div>
              </div>
            ))}
            <div style={{ width: 1, height: 28, background: "var(--border-subtle)" }} />
          </div>
        )}

        {/* Verdict badge — colored background */}
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
          textTransform: "uppercase",
          background: badgeBg,
          color: badgeColor,
          padding: "3px 10px", borderRadius: 20,
        }}>
          {badgeText()}
        </span>

        {/* Chevron */}
        <ChevronDown
          size={16}
          className={`result-chevron ${open ? "open" : ""}`}
          style={{ flexShrink: 0, opacity: 0.5, color: "var(--text-muted)" }}
        />
      </div>

      {/* Collapsible code panel */}
      <div className={`result-code ${open ? "open" : "closed"}`}>
        <pre style={{
          margin: 0,
          padding: "16px 20px",
          background: "var(--bg-card)",
          borderTop: "1px solid var(--border-subtle)",
          fontSize: 12,
          fontFamily: "'Fira Code','Cascadia Code','Consolas',monospace",
          color: "var(--text-primary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.65,
          overflowX: "auto",
        }}>
          {slot.submittedCode || <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>No code submitted.</span>}
        </pre>
      </div>
    </div>
  );
}

// ── Full results body (no header — header is always rendered by SprintPage) ──────
function ResultsScreen({ slots, finalStr, wpm, totalChars, accepted, onPlayAgain }: {
  slots: Slot[];
  finalStr: string;
  wpm: number;
  totalChars: number;
  accepted: number;
  onPlayAgain: () => void;
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const toggle = (i: number) => setOpenIdx(prev => prev === i ? null : i);

  return (
    <div className="results-enter" style={{
      flex: 1, overflowY: "auto",
      background: "var(--bg-secondary)",
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "48px 24px 64px",
    }}>
      <style>{MD_STYLES}</style>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 48, textAlign: "center", marginBottom: 40 }}>
        {[
          { label: "Time", val: finalStr },
          { label: "Characters", val: String(totalChars) },
          { label: "WPM", val: String(Math.max(0, wpm)) },
          { label: "Accepted", val: `${accepted}/${slots.length}` },
        ].map(({ label, val }) => (
          <div key={label}>
            <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: "-0.04em", color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>{val}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Accordion problem list */}
      <div style={{ width: "100%", maxWidth: 680, display: "flex", flexDirection: "column", gap: 10 }}>
        {slots.map((s, i) => (
          <ResultRow key={i} slot={s} idx={i} open={openIdx === i} onToggle={() => toggle(i)} />
        ))}
      </div>

      <button
        onClick={onPlayAgain}
        title="Play Again"
        style={{ marginTop: 36, width: 40, height: 40, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg-tertiary)", border: "none", borderRadius: 8, cursor: "pointer", color: "var(--text-muted)", transition: "background 0.15s" }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--border-subtle)")}
        onMouseLeave={e => (e.currentTarget.style.background = "var(--bg-tertiary)")}
      >
        <House size={18} />
      </button>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SprintPage() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [lang, setLang] = useState<Lang>("python");
  const [code, setCode] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [cur, setCur] = useState(0);
  const [sprintSize, setSprintSize] = useState<number>(5);
  const [timer, setTimer] = useState<{ start: number; end: number | null }>({ start: 0, end: null });
  // ── Editor settings ──
  const [editorFontSize, setEditorFontSize] = useState(13);
  const [editorFont, setEditorFont] = useState(EDITOR_FONTS[0].css);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showTimer, setShowTimer] = useState(true);
  /** Stores per-language editor content for the intro (a_plus_b) problem. */
  const introCodeByLang = useRef<Partial<Record<Lang, string>>>({});
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Timestamp (ms) when the current sprint problem was first displayed */
  const problemStartTime = useRef<number>(0);
  /** Shared UUID for all submissions in one sprint session, for stats correlation */
  const sprintId = useRef<string>("");
  const [, setTick] = useState(0);

  const { problem: introProblem, loading: introLoading } = useProblem("a_plus_b");
  const { status: introStatus, submit: introSubmit, reset: introReset } = useJudge();
  const { submit: sprintSubmit, closeAll } = useSprintJudge();

  // ── Intro editor: seed with starter code only on first load ───────────────
  useEffect(() => {
    if (phase !== "intro" || !introProblem) return;
    // Only overwrite the editor if we don't already have stored content for this lang
    if (!introCodeByLang.current[lang]) {
      const starter = introProblem.starter_code?.[lang] ?? "";
      introCodeByLang.current[lang] = starter;
      setCode(starter);
    }
  }, [introProblem, lang, phase]);

  // ── Phase 1 → 2: Accepted on intro ───────────────────────────────────────
  useEffect(() => {
    if (phase !== "intro" || introStatus.kind !== "success") return;
    setPhase("transition");
    fetchRandomProblems(sprintSize)
      .then((problems) => {
        const s: Slot[] = problems.map((p, i) => ({
          problem: p,
          lang,
          // Seed only the currently selected language; others default to starter code on first switch
          codeByLang: { [lang]: p.starter_code?.[lang] ?? "" } as Partial<Record<Lang, string>>,
          status: i === 0 ? "active" : "future",
          verdict: null,
          verdictMessage: null,
          submittedCode: "",
          submitMs: null,
          extraChars: null,
          slotWpm: null,
        }));
        setSlots(s);
        setCode(s[0].codeByLang[lang] ?? "");
        setCur(0);
        sprintId.current = crypto.randomUUID();
        problemStartTime.current = Date.now();
        setPhase("sprint");
        setTimer({ start: Date.now(), end: null });
        tickRef.current = setInterval(() => setTick(t => t + 1), 500);
      })
      .catch(() => setPhase("intro"));
  }, [introStatus.kind, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
    closeAll();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live timer string ─────────────────────────────────────────────────────
  const elapsedMs = timer.end ? timer.end - timer.start : (phase === "sprint" ? Date.now() - timer.start : 0);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const elapsedStr = `${String(Math.floor(elapsedSec / 60)).padStart(2, "0")}:${String(elapsedSec % 60).padStart(2, "0")}`;

  // ── Sprint submit: immediate advance, background WS ───────────────────────
  const handleSprintSubmit = useCallback(() => {
    if (phase !== "sprint") return;
    const slot = slots[cur];
    const submittedCode = code;
    const now = Date.now();

    // Per-problem stats
    const submitMs = now - problemStartTime.current;
    const starterLen = nonWs(slot.problem.starter_code?.[slot.lang] ?? "");
    const extraChars = Math.max(0, nonWs(submittedCode) - starterLen);
    const minutes = submitMs / 60000;
    const slotWpm = minutes > 0 ? Math.round((extraChars / 5) / minutes) : 0;

    setSlots(prev => {
      const next = [...prev];
      // Persist the current editor content for this language before marking pending
      next[cur] = {
        ...next[cur],
        codeByLang: { ...next[cur].codeByLang, [lang]: submittedCode },
        submittedCode,
        status: "pending",
        submitMs,
        extraChars,
        slotWpm,
      };
      if (cur + 1 < sprintSize) next[cur + 1] = { ...next[cur + 1], status: "active" };
      return next;
    });

    const nextIdx = cur + 1;
    if (nextIdx < sprintSize) {
      setCur(nextIdx);
      problemStartTime.current = Date.now();
      // Load next slot's code for the current language (starter code on first visit)
      const nextSlot = slots[nextIdx];
      setCode(nextSlot.codeByLang[lang] ?? nextSlot.problem.starter_code?.[lang] ?? "");
    } else {
      const endTime = Date.now();
      if (tickRef.current) clearInterval(tickRef.current);
      setTimer(t => ({ ...t, end: endTime }));
      setCur(sprintSize);
      setTimeout(() => setPhase("results"), 50);
    }

    sprintSubmit(
      cur,
      {
        lang: slot.lang,
        code: submittedCode,
        problem_id: slot.problem.id,
        problem_title: slot.problem.meta?.title ?? slot.problem.id,
        sprint_id: sprintId.current,
        sprint_size: sprintSize,
        slot_index: cur,
        problem_ms: submitMs,
      },
      (slotIdx, verdict) => {
        setSlots(prev => {
          const next = [...prev];
          next[slotIdx] = {
            ...next[slotIdx],
            verdict: verdict.kind,
            verdictMessage: verdict.message ?? null,
            status: verdict.kind === "success" ? "accepted" : "rejected",
          };
          return next;
        });
      },
    );
  }, [phase, slots, cur, lang, code, sprintSize, sprintSubmit]);

  // ── Lang switch ───────────────────────────────────────────────────────────
  const handleLangChange = useCallback((nextLang: Lang) => {
    if (phase === "intro") {
      // Save current editor content for the outgoing language
      introCodeByLang.current[lang] = code;
      // Restore previously stored content, or fall back to starter code
      const restored = introCodeByLang.current[nextLang]
        ?? introProblem?.starter_code?.[nextLang]
        ?? "";
      if (!introCodeByLang.current[nextLang]) introCodeByLang.current[nextLang] = restored;
      setCode(restored);
      setLang(nextLang);
    } else if (phase === "sprint") {
      // Save current editor content for the outgoing language in this slot
      setSlots(prev => {
        const n = [...prev];
        n[cur] = { ...n[cur], codeByLang: { ...n[cur].codeByLang, [lang]: code }, lang: nextLang };
        return n;
      });
      // Restore previously stored content, or fall back to starter code
      const slot = slots[cur];
      const restored = slot.codeByLang[nextLang]
        ?? slot.problem.starter_code?.[nextLang]
        ?? "";
      setCode(restored);
      setLang(nextLang);
    }
  }, [phase, lang, code, introProblem, cur, slots]);

  // ── WPM (used on results screen) ──────────────────────────────────────────
  const totalMs = (timer.end ?? Date.now()) - timer.start;
  const totalMinutes = totalMs / 60000;
  const totalTypedChars = slots.reduce((s, sl) => s + nonWs(sl.submittedCode), 0);
  const totalStarterChars = slots.reduce((s, sl) => s + nonWs(sl.problem.starter_code?.[sl.lang] ?? ""), 0);
  const totalChars = Math.max(0, totalTypedChars - totalStarterChars);
  const wpm = totalMinutes > 0 ? Math.round((totalChars / 5) / totalMinutes) : 0;

  const currentProblem = phase === "intro" ? introProblem : phase === "sprint" ? slots[cur]?.problem ?? null : null;
  const isSubmitting = introStatus.kind === "queued" || introStatus.kind === "running";

  const handlePlayAgain = () => {
    introReset();
    setPhase("intro");
    setSlots([]);
    setCur(0);
    setTimer({ start: 0, end: null });
    sprintId.current = "";
    if (introProblem?.starter_code?.[lang]) setCode(introProblem.starter_code[lang]);
  };

  // Compute results data (always; used when phase === "results")
  const fs = Math.floor(totalMs / 1000);
  const finalStr = `${String(Math.floor(fs / 60)).padStart(2, "0")}:${String(fs % 60).padStart(2, "0")}`;
  const accepted = slots.filter(s => s.status === "accepted").length;

  // ════════════════════════════════════════════════════════════════════════════
  // SHARED SHELL  (header always visible across all phases)
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg-primary)", overflow: "hidden" }}>
      <style>{MD_STYLES}</style>

      {/* ── Top bar (always rendered) ── */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", height: 58, background: "var(--bg-secondary)", flexShrink: 0, gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Logo — regular link so right-click → open in new tab works */}
          <a
            href="/"
            onClick={e => { e.preventDefault(); handlePlayAgain(); }}
            style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none", color: "inherit" }}
          >
            {/* <div style={{ width: 34, height: 34, borderRadius: 7, background: "linear-gradient(135deg,#388bfd,#bc8cff)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Zap size={17} color="#fff" fill="#fff" />
            </div> */}
            <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>lazyjudge</span>
          </a>
          {/* Settings gear — filled, same muted gray as the title */}
          <button
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 7, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", transition: "background 0.15s", marginLeft: 2 }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <Settings size={18} color="var(--text-muted)" />
          </button>
          <button
            onClick={() => setShowHelp(true)}
            title="About"
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: 7, border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", transition: "background 0.15s", marginLeft: 2 }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-tertiary)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
          >
            <CircleHelp size={18} color="var(--text-muted)" />
          </button>
          {phase === "sprint" && (
            <span style={{ fontSize: 13, color: "#bf6211", background: "var(--bg-primary)", padding: "3px 11px", borderRadius: 12, fontWeight: 600 }}>
              {cur + 1} / {sprintSize}
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 19 }}>
          {phase === "intro" && (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ display: "flex", borderRadius: 7, overflow: "hidden", background: "var(--bg-primary)" }}>
                {SPRINT_OPTIONS.map(n => (
                  <button
                    key={n}
                    onClick={() => setSprintSize(n)}
                    style={{
                      width: 38, height: 34, border: "none",
                      background: "transparent",
                      color: sprintSize === n ? "#bf6211" : "var(--text-secondary)",
                      fontSize: 14, fontWeight: 700, cursor: "pointer",
                      transition: "color 0.15s",
                    }}
                  >{n}</button>
                ))}
              </div>
              <div style={{ width: 1, height: 22, background: "var(--border-subtle)" }} />
              <div style={{
                minWidth: 58, fontSize: 19, fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                visibility: showTimer ? "visible" : "hidden",
                color: introStatus.kind === "success" ? "var(--accent-green)"
                  : (introStatus.kind === "error" || introStatus.kind === "wrong_answer") ? "var(--accent-red)"
                    : "var(--text-secondary)",
              }}>
                {isSubmitting
                  ? <Loader2 size={14} className="animate-spin" style={{ display: "inline" }} />
                  : (introStatus.kind === "idle" ? "0:00" : introStatus.message)
                }
              </div>
            </div>
          )}
          {phase === "sprint" && (
            <div style={{
              fontSize: 19, fontWeight: 700,
              color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums",
              visibility: showTimer ? "visible" : "hidden",
            }}>
              {elapsedStr}
            </div>
          )}
        </div>
      </header>

      {showSettings && (
        <SettingsOverlay
          fontSize={editorFontSize}
          setFontSize={setEditorFontSize}
          fontCss={editorFont}
          setFontCss={setEditorFont}
          showTimer={showTimer}
          setShowTimer={setShowTimer}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
      {/* ── Phase bodies ── */}
      {phase === "results" && (
        <ResultsScreen
          slots={slots}
          finalStr={finalStr}
          wpm={wpm}
          totalChars={totalChars}
          accepted={accepted}
          onPlayAgain={handlePlayAgain}
        />
      )}
      {phase === "transition" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "var(--bg-primary)", gap: 18 }}>
          <Loader2 size={34} className="animate-spin" style={{ color: "var(--accent-blue)" }} />
          <div style={{ fontSize: 15, color: "var(--text-secondary)" }}>Loading your sprint problems…</div>
        </div>
      )}
      {(phase === "intro" || phase === "sprint") && (
        <SplitLayout
          phase={phase}
          slots={slots}
          introLoading={introLoading}
          currentProblem={currentProblem}
          lang={lang}
          code={code}
          setCode={setCode}
          handleLangChange={handleLangChange}
          introReset={introReset}
          introSubmit={introSubmit}
          introProblem={introProblem}
          handleSprintSubmit={handleSprintSubmit}
          isSubmitting={isSubmitting}
          introStatus={introStatus}
          editorFontSize={editorFontSize}
          editorFont={editorFont}
        />
      )}
    </div>
  );
}

// ── Settings overlay ─────────────────────────────────────────────────────────
function SettingsOverlay({
  fontSize, setFontSize, fontCss, setFontCss, showTimer, setShowTimer, onClose,
}: {
  fontSize: number;
  setFontSize: (n: number) => void;
  fontCss: string;
  setFontCss: (s: string) => void;
  showTimer: boolean;
  setShowTimer: (v: boolean) => void;
  onClose: () => void;
}) {
  // Local string state so the user can type freely; we only commit on blur/Enter
  const [sizeStr, setSizeStr] = useState(String(fontSize));

  function commitSize(raw: string) {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) {
      const clamped = Math.min(72, Math.max(6, n));
      setFontSize(clamped);
      setSizeStr(String(clamped));
    } else {
      setSizeStr(String(fontSize)); // revert garbage input
    }
  }

  return (
    /* Backdrop */
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {/* Panel — stops click propagation so clicking inside doesn't close */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "60%",
          maxHeight: "72vh",
          overflowY: "auto",
          background: "#28292c",
          borderRadius: 14,
          border: "1px solid var(--border-subtle)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          padding: "28px 32px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 28,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Settings size={16} style={{ color: "var(--text-secondary)" }} />
          <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>Settings</span>
        </div>

        {/* ── Editor Font Size ── */}
        <section>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 12 }}>Editor Font Size</div>
          <style>{`
            .settings-size-input::-webkit-outer-spin-button,
            .settings-size-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
            .settings-size-input { -moz-appearance: textfield; }
          `}</style>
          <input
            className="settings-size-input"
            type="number"
            min={6} max={72}
            value={sizeStr}
            onChange={e => setSizeStr(e.target.value)}
            onBlur={e => commitSize(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") commitSize((e.target as HTMLInputElement).value); }}
            style={{
              width: 72, padding: "6px 10px",
              background: "var(--bg-tertiary)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 6, color: "var(--text-primary)",
              fontSize: 13, fontFamily: "inherit",
              outline: "none", textAlign: "center",
            }}
          />
          <span style={{ marginLeft: 10, fontSize: 12, color: "var(--text-muted)" }}>px (6 – 72)</span>
        </section>

        {/* ── Editor Font ── */}
        <section>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 12 }}>Editor Font</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {EDITOR_FONTS.map(f => {
              const active = fontCss === f.css;
              return (
                <button
                  key={f.label}
                  onClick={() => setFontCss(f.css)}
                  style={{
                    fontFamily: f.css,
                    fontSize: 13,
                    padding: "10px 18px",
                    borderRadius: 8,
                    border: active ? "2px solid var(--accent-blue)" : "1px solid var(--border-subtle)",
                    background: active ? "rgba(56,139,253,0.12)" : "var(--bg-tertiary)",
                    color: active ? "var(--accent-blue)" : "var(--text-primary)",
                    cursor: "pointer",
                    transition: "border-color 0.15s, background 0.15s, color 0.15s",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Show Timer ── */}
        <section>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 12 }}>Show Timer</div>
          <div style={{ display: "flex", gap: 0, borderRadius: 7, overflow: "hidden", width: "fit-content", border: "1px solid var(--border-subtle)" }}>
            {([true, false] as const).map((val, i) => (
              <button
                key={String(val)}
                onClick={() => setShowTimer(val)}
                style={{
                  padding: "6px 18px",
                  border: "none",
                  borderRight: i === 0 ? "1px solid var(--border-subtle)" : "none",
                  background: showTimer === val ? "var(--accent-blue)" : "var(--bg-tertiary)",
                  color: showTimer === val ? "#fff" : "var(--text-secondary)",
                  fontSize: 12, fontWeight: 600, cursor: "pointer",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                {val ? "On" : "Off"}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Draggable split layout ────────────────────────────────────────────────────
function SplitLayout({
  phase, slots, introLoading, currentProblem, lang, code, setCode,
  handleLangChange, introReset, introSubmit, introProblem,
  handleSprintSubmit, isSubmitting, introStatus,
  editorFontSize, editorFont,
}: {
  phase: Phase;
  slots: Slot[];
  introLoading: boolean;
  currentProblem: ProblemData | null;
  lang: Lang;
  code: string;
  setCode: (v: string) => void;
  handleLangChange: (l: Lang) => void;
  introReset: () => void;
  introSubmit: (p: { lang: Lang; code: string; problem_id: string; problem_title?: string }) => void;
  introProblem: ProblemData | null;
  handleSprintSubmit: () => void;
  isSubmitting: boolean;
  introStatus: { kind: string; message: string };
  editorFontSize: number;
  editorFont: string;
}) {
  const [splitPct, setSplitPct] = useState(38);
  const [limitExceeded, setLimitExceeded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setSplitPct(Math.min(75, Math.max(20, pct)));
  }, []);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  return (
    <div
      ref={containerRef}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ display: "flex", flex: 1, overflow: "hidden" }}
    >
      {/* Problem panel */}
      <aside style={{ width: `${splitPct}%`, display: "flex", flexDirection: "column", background: "var(--bg-secondary)", overflow: "hidden", flexShrink: 0 }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
          {introLoading && phase === "intro" ? (
            <div className="shimmer" style={{ height: 20, width: 160, borderRadius: 4 }} />
          ) : (
            <h1 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>
              {currentProblem?.meta.title ?? "\u2014"}
            </h1>
          )}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
          {currentProblem ? (
            <div className="md-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{currentProblem.description}</ReactMarkdown>
            </div>
          ) : (
            !introLoading && <div style={{ color: "var(--text-muted)", fontSize: 13 }}>No problem loaded.</div>
          )}
        </div>
      </aside>

      {/* Drag handle */}
      <div
        onPointerDown={onPointerDown}
        style={{
          width: 6, flexShrink: 0, cursor: "col-resize",
          background: "var(--bg-secondary)",
          borderLeft: "1px solid var(--border-subtle)",
          borderRight: "1px solid var(--border-subtle)",
          display: "flex", alignItems: "center", justifyContent: "center",
          transition: "background 0.15s",
          userSelect: "none",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--border-subtle)")}
        onMouseLeave={e => (e.currentTarget.style.background = "var(--bg-secondary)")}
      >
        <div style={{ width: 2, height: 24, borderRadius: 1, background: "var(--border-subtle)" }} />
      </div>

      {/* Editor + sprint sidebar */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", minWidth: 0 }}>
        <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 14px", background: "var(--bg-secondary)", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
            {/* Left: lang selector + char counter */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                <select
                  value={lang}
                  onChange={e => handleLangChange(e.target.value as Lang)}
                  style={{ appearance: "none", background: "var(--bg-tertiary)", border: "1px solid var(--border-subtle)", borderRadius: 6, color: "var(--text-secondary)", fontSize: 12, fontWeight: 500, padding: "5px 28px 5px 10px", cursor: "pointer", outline: "none" }}
                >
                  {(Object.keys(LANG_META) as Lang[]).map(l => (
                    <option key={l} value={l}>{LANG_META[l].label}</option>
                  ))}
                </select>
                <ChevronDown size={11} style={{ position: "absolute", right: 7, color: "var(--text-secondary)", pointerEvents: "none" }} />
              </div>
              {/* Char counter pill + over-limit error */}
              {(() => {
                const len = [...code].length;
                const over = len > MAX_CODE_LEN;
                // Clear the "attempted submit" warning once user is back under the limit
                if (!over && limitExceeded) setLimitExceeded(false);
                return (
                  <>
                    <span style={{
                      background: over ? "rgba(248,81,73,0.15)" : "var(--bg-tertiary)",
                      border: `1px solid ${over ? "rgba(248,81,73,0.5)" : "var(--border-subtle)"}`,
                      borderRadius: 6, padding: "5px 10px", fontSize: 12, fontWeight: 500,
                      color: over ? "var(--accent-red)" : "var(--text-secondary)",
                      fontVariantNumeric: "tabular-nums",
                      transition: "color 0.15s, border-color 0.15s, background 0.15s",
                      userSelect: "none",
                    }}>
                      {len}/{MAX_CODE_LEN}
                    </span>
                    {limitExceeded && (
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-red)", whiteSpace: "nowrap" }}>
                        Input Limit Exceeded
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  if ([...code].length > MAX_CODE_LEN) { setLimitExceeded(true); return; }
                  if (phase === "intro") { if (introProblem) introSubmit({ lang, code, problem_id: introProblem.id, problem_title: introProblem.meta?.title ?? introProblem.id }); }
                  else handleSprintSubmit();
                }}
                disabled={phase === "intro" ? (isSubmitting || introLoading) : false}
                style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 18px", background: "var(--bg-primary)", border: "none", borderRadius: 6, color: isSubmitting ? "var(--text-muted)" : "#bf6211", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: phase === "intro" && (isSubmitting || introLoading) ? 0.5 : 1, transition: "opacity 0.15s" }}
              >
                {isSubmitting && <Loader2 size={12} className="animate-spin" />}
                {phase === "intro" ? (isSubmitting ? "Judging\u2026" : "Submit") : "Submit & Next"}
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflow: "hidden" }}>
            <MonacoEditor
              height="100%"
              language={LANG_META[lang].monacoLang}
              value={code}
              onChange={v => setCode(v ?? "")}
              theme="vs-dark"
              options={{ fontSize: editorFontSize, fontFamily: editorFont, fontLigatures: true, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 4, wordWrap: "on", padding: { top: 10, bottom: 10 }, smoothScrolling: true, cursorBlinking: "smooth", overviewRulerLanes: 0, lineNumbersMinChars: 3, lineDecorationsWidth: 4, scrollbar: { vertical: "auto", horizontal: "auto", useShadows: false, verticalScrollbarSize: 6 } }}
            />
          </div>
          {phase === "intro" && introStatus.kind !== "idle" && (
            <div style={{ borderTop: "1px solid var(--border-subtle)", padding: "8px 14px", background: "var(--bg-secondary)", flexShrink: 0, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: introStatus.kind === "success" ? "var(--accent-green)" : introStatus.kind === "running" || introStatus.kind === "queued" ? "var(--accent-blue)" : "var(--accent-red)" }}>
                {introStatus.message}
              </span>
              {introStatus.kind === "success" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading sprint\u2026</span>}
            </div>
          )}
        </main>
        {phase === "sprint" && <SprintSidebar slots={slots} />}
      </div>
    </div>
  );
}

const HELP_MARKDOWN = `
## Feedback

Open Suggestions Form :
[Google Form](https://docs.google.com/forms/d/e/1FAIpQLSfnM1j0SMCB_fbG_qD0P6xoxblWTbiQXa5zwdj98oLvRg62zg/viewform?usp=publish-editor)
`;

// ── Help overlay ──────────────────────────────────────────────────────────────
function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.55)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "60%",
          maxHeight: "72vh",
          overflowY: "auto",
          background: "#28292c",
          borderRadius: 14,
          border: "1px solid var(--border-subtle)",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          padding: "28px 32px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <CircleHelp size={16} style={{ color: "var(--text-secondary)" }} />
            <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>About</span>
          </div>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", fontSize: 18, lineHeight: 1, padding: "2px 6px", borderRadius: 4 }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--text-primary)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            ✕
          </button>
        </div>

        {/* Markdown body */}
        <div className="md-body">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#bf6211", textDecoration: "underline" }}
                >
                  {children}
                </a>
              ),
            }}
          >
            {HELP_MARKDOWN}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
