import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, Play, Pause, SkipBack, SkipForward, RotateCcw } from "lucide-react";
import { SPEECH_RATES, useSpeech } from "@/hooks/useSpeech";
import { wordIndexAt, type ReadDoc, type ReadSentence } from "@/lib/readAlong";

type SpeechApi = ReturnType<typeof useSpeech>;

export interface ReadTheme {
  bg: string;
  lines: string;
  headerBg: string;
  toolbarBg: string;
  textMuted: string;
  borderAccent: string;
  text: string;
}

interface ReadAlongViewProps {
  doc: ReadDoc;
  speech: SpeechApi;
  /** chave do localStorage onde guardamos "onde parou" (null = não guardar) */
  storageKey: string | null;
  theme: ReadTheme;
  isDark: boolean;
  textColor: string;
  fontSize: number;
  /** frase em que a leitura começou (se > 0, mostra o aviso "continuando de onde parou") */
  resumedFrom: number;
  onClose: () => void;
}

const ACCENT = "#2D9E7F";

// ── Uma frase: só re-desenha quando ela fica ativa/inativa ou a palavra destacada muda ──
interface SentenceViewProps {
  s: ReadSentence;
  active: boolean;
  activeWord: number;
  sentenceBg: string;
  onWordClick: (sentenceId: number, charStart: number) => void;
}

const SentenceView = memo(function SentenceView({ s, active, activeWord, sentenceBg, onWordClick }: SentenceViewProps) {
  return (
    <span
      data-sent={s.id}
      style={{
        background: active ? sentenceBg : "transparent",
        borderRadius: 6,
        padding: "2px 0",
        WebkitBoxDecorationBreak: "clone",
        boxDecorationBreak: "clone",
        transition: "background 0.2s ease",
      }}
    >
      {s.words.map((w, i) => {
        const isWord = active && i === activeWord;
        return (
          <span key={i}>
            {i > 0 ? " " : ""}
            <span
              data-w={i}
              onClick={() => onWordClick(s.id, w.s)}
              style={{
                background: isWord ? ACCENT : "transparent",
                color: isWord ? "#FFFFFF" : undefined,
                fontWeight: w.bold ? 700 : undefined,
                borderRadius: 4,
                padding: "1px 2px",
                margin: "0 -2px",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {s.text.slice(w.s, w.e)}
            </span>
          </span>
        );
      })}
      {" "}
    </span>
  );
});

export function ReadAlongView({
  doc,
  speech,
  storageKey,
  theme,
  isDark,
  textColor,
  fontSize,
  resumedFrom,
  onClose,
}: ReadAlongViewProps) {
  const { sentences } = doc;
  const total = sentences.length;
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrollUntilRef = useRef(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const [showResumed, setShowResumed] = useState(resumedFrom > 0);

  const { jumpTo } = speech; // função estável: mantém as frases sem redesenhar à toa
  const pos = speech.position;
  const activeIdx = pos && pos.index < total ? pos.index : -1;
  const activeSentence = activeIdx >= 0 ? sentences[activeIdx] : null;
  const activeWord = activeSentence && pos ? wordIndexAt(activeSentence, pos.start) : -1;

  // Agrupa as frases em parágrafos
  const paras = useMemo(() => {
    const out: ReadSentence[][] = [];
    sentences.forEach((s) => {
      if (s.paraStart || out.length === 0) out.push([s]);
      else out[out.length - 1].push(s);
    });
    return out;
  }, [sentences]);

  const base = Math.max(18, Math.round(fontSize * 1.2));
  const sentenceBg = isDark ? "rgba(45,158,127,0.26)" : "rgba(45,158,127,0.16)";

  // Aviso "continuando de onde parou" some sozinho
  useEffect(() => {
    if (!showResumed) return;
    const t = window.setTimeout(() => setShowResumed(false), 7000);
    return () => window.clearTimeout(t);
  }, [showResumed]);

  // Guarda onde parou (por frase) — e apaga se a nota foi lida até o fim
  useEffect(() => {
    if (!storageKey) return;
    try {
      if (speech.finished) localStorage.removeItem(storageKey);
      else if (activeIdx >= 0) localStorage.setItem(storageKey, JSON.stringify({ i: activeIdx, n: total }));
    } catch {
      /* sem storage */
    }
  }, [storageKey, activeIdx, total, speech.finished]);

  // Rolagem automática: mantém a palavra lida sempre visível (a menos que você esteja rolando a tela)
  useEffect(() => {
    const box = scrollRef.current;
    if (!box || activeIdx < 0) return;
    if (Date.now() < userScrollUntilRef.current) return;
    const el =
      box.querySelector<HTMLElement>(`[data-sent="${activeIdx}"] [data-w="${Math.max(0, activeWord)}"]`) ||
      box.querySelector<HTMLElement>(`[data-sent="${activeIdx}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const c = box.getBoundingClientRect();
    const top = c.top + c.height * 0.2;
    const bottom = c.bottom - c.height * 0.3;
    if (r.top < top || r.bottom > bottom) {
      box.scrollTo({ top: box.scrollTop + (r.top - c.top) - c.height * 0.35, behavior: "smooth" });
    }
  }, [activeIdx, activeWord]);

  const pauseAutoScroll = () => {
    userScrollUntilRef.current = Date.now() + 5000;
  };

  // Tocar numa palavra: a leitura continua a partir dali
  const handleWordClick = useCallback(
    (sentenceId: number, charStart: number) => {
      try {
        if (window.getSelection()?.toString()) return; // está selecionando texto, não é toque
      } catch {
        /* ignora */
      }
      userScrollUntilRef.current = 0;
      setShowResumed(false);
      jumpTo(sentenceId, charStart, true);
    },
    [jumpTo]
  );

  const handleClose = () => {
    speech.stop();
    onClose();
  };

  const handlePlayPause = () => {
    userScrollUntilRef.current = 0;
    setShowResumed(false);
    if (speech.speaking) speech.stop();
    else speech.resume();
  };

  const handlePrev = () => {
    userScrollUntilRef.current = 0;
    // Já passou do começo da frase? Volta pro começo dela; senão, vai para a anterior.
    const target = activeWord > 2 ? activeIdx : activeIdx - 1;
    speech.jumpTo(Math.max(0, target), 0, speech.speaking);
  };

  const handleNext = () => {
    userScrollUntilRef.current = 0;
    speech.jumpTo(Math.min(total - 1, Math.max(0, activeIdx) + 1), 0, speech.speaking);
  };

  const handleRestart = () => {
    userScrollUntilRef.current = 0;
    setShowResumed(false);
    speech.jumpTo(0, 0, true);
  };

  const commitScrub = () => {
    if (scrub === null) return;
    userScrollUntilRef.current = 0;
    speech.jumpTo(scrub, 0, speech.speaking);
    setScrub(null);
  };

  const sliderValue = scrub ?? Math.max(0, activeIdx);
  const pct = total > 1 ? Math.round(((Math.max(0, activeIdx) + (speech.finished ? 1 : 0)) / total) * 100) : 100;

  const roundBtn: React.CSSProperties = {
    width: 46,
    height: 46,
    borderRadius: "50%",
    background: "transparent",
    border: `1px solid ${theme.lines}`,
    color: textColor,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  return (
    <div
      className="absolute inset-0 z-[100] flex flex-col"
      style={{ background: theme.bg }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Topo */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 12px 10px 16px",
          paddingTop: "calc(12px + env(safe-area-inset-top))",
          background: theme.headerBg,
          flexShrink: 0,
        }}
      >
        <span style={{ color: textColor, fontWeight: 700, fontSize: 15 }}>🔊 Ouvindo a nota</span>
        <button
          onClick={handleClose}
          aria-label="Fechar leitura"
          style={{ background: "none", border: "none", color: textColor, padding: 8, display: "flex" }}
        >
          <X size={24} />
        </button>
      </div>

      {showResumed && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 14px",
            background: isDark ? "rgba(45,158,127,0.25)" : "rgba(45,158,127,0.15)",
            color: textColor,
            fontSize: 13,
            flexShrink: 0,
          }}
        >
          <span>▶ Continuando de onde você parou</span>
          <button
            onClick={handleRestart}
            style={{
              color: ACCENT,
              fontWeight: 700,
              fontSize: 13,
              background: "none",
              border: "none",
              padding: "4px 6px",
            }}
          >
            Do início
          </button>
        </div>
      )}

      {/* Texto */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-5"
        style={{
          touchAction: "pan-y",
          WebkitOverflowScrolling: "touch",
          overscrollBehavior: "contain",
          color: textColor,
        }}
        onTouchStart={pauseAutoScroll}
        onWheel={pauseAutoScroll}
      >
        {paras.map((group, pi) => {
          const first = group[0];
          const kind = first.kind;
          const isTitle = kind === "title";
          const isHeading = kind === "heading";
          const hasMarker = !!first.marker;
          return (
            <div
              key={pi}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                marginBottom: isTitle ? 22 : isHeading ? 14 : 12,
                marginTop: isHeading ? 8 : 0,
                fontSize: isTitle ? Math.round(base * 1.4) : isHeading ? Math.round(base * 1.15) : base,
                fontWeight: isTitle || isHeading ? 700 : 400,
                lineHeight: 1.75,
                opacity: first.checked ? 0.7 : 1,
                wordBreak: "break-word",
              }}
            >
              {hasMarker && (
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    minWidth: 22,
                    textAlign: "center",
                    color: first.checked ? "#4CAF50" : theme.textMuted,
                    fontWeight: 700,
                  }}
                >
                  {first.marker}
                </span>
              )}
              <div style={{ minWidth: 0, flex: 1, textDecoration: first.checked ? "line-through" : "none" }}>
                {group.map((s) => (
                  <SentenceView
                    key={s.id}
                    s={s}
                    active={s.id === activeIdx}
                    activeWord={s.id === activeIdx ? activeWord : -1}
                    sentenceBg={sentenceBg}
                    onWordClick={handleWordClick}
                  />
                ))}
              </div>
            </div>
          );
        })}
        <p style={{ textAlign: "center", color: theme.textMuted, fontSize: 12, margin: "18px 0 40px" }}>
          {speech.finished ? "✔ Fim da nota" : "Toque em qualquer palavra para continuar a leitura dali"}
        </p>
      </div>

      {/* Controles */}
      <div
        style={{
          background: theme.toolbarBg,
          borderTop: `1px solid ${theme.lines}`,
          padding: "10px 14px calc(10px + env(safe-area-inset-bottom))",
          display: "flex",
          flexDirection: "column",
          gap: 10,
          flexShrink: 0,
        }}
      >
        {/* Progresso (arraste para pular para outro trecho) */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            type="range"
            min={0}
            max={Math.max(0, total - 1)}
            value={sliderValue}
            onChange={(e) => {
              pauseAutoScroll();
              setScrub(Number(e.target.value));
            }}
            onPointerUp={commitScrub}
            onKeyUp={commitScrub}
            onBlur={commitScrub}
            aria-label="Progresso da leitura"
            style={{ flex: 1, accentColor: ACCENT }}
          />
          <span style={{ color: theme.textMuted, fontSize: 12, minWidth: 34, textAlign: "right" }}>{pct}%</span>
        </div>

        {/* Voltar · Play/Pausa · Avançar · Do início */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14 }}>
          <button onClick={handleRestart} aria-label="Recomeçar do início" title="Do início" style={roundBtn}>
            <RotateCcw size={20} />
          </button>
          <button onClick={handlePrev} aria-label="Frase anterior" style={roundBtn}>
            <SkipBack size={22} />
          </button>
          <button
            onClick={handlePlayPause}
            aria-label={speech.speaking ? "Pausar" : "Ouvir"}
            style={{
              width: 62,
              height: 62,
              borderRadius: "50%",
              background: ACCENT,
              border: "none",
              color: "#FFF",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 4px 14px rgba(45,158,127,0.4)",
              flexShrink: 0,
            }}
          >
            {speech.speaking ? <Pause size={30} /> : <Play size={30} style={{ marginLeft: 3 }} />}
          </button>
          <button onClick={handleNext} aria-label="Próxima frase" style={roundBtn}>
            <SkipForward size={22} />
          </button>
          <div style={{ width: 46, flexShrink: 0 }} />
        </div>

        {/* Velocidade */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, flexWrap: "wrap" }}>
          {SPEECH_RATES.map((r) => {
            const on = speech.rate === r;
            return (
              <button
                key={r}
                onClick={() => speech.setRate(r)}
                aria-pressed={on}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 700,
                  background: on ? ACCENT : "transparent",
                  color: on ? "#FFF" : textColor,
                  border: `1px solid ${on ? ACCENT : theme.lines}`,
                }}
              >
                {String(r).replace(".", ",")}x
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
