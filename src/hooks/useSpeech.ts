import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { TextToSpeech, QueueStrategy } from "@capacitor-community/text-to-speech";
import { prepareForSpeech, splitForSpeech } from "@/lib/noteText";
import { startReadAloudService, stopReadAloudService } from "@/lib/uiTools";

const LANG = "pt-BR";
const RATE_KEY = "readalong_rate";

/**
 * No Android (app instalado), quantos trechos são mandados de uma vez para o motor de voz
 * do celular. Com a tela bloqueada o app pode ficar "congelado" e não conseguir mandar o
 * próximo trecho a tempo; como o motor de voz já recebeu a fila (praticamente a nota inteira),
 * ele continua lendo sozinho. Antes eram só 60 trechos: acabavam depois de alguns minutos com
 * a tela bloqueada e a voz parava.
 */
const FILA_NATIVA = 500;

/** Velocidades oferecidas na tela de leitura. */
export const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 2];

/** Um trecho (normalmente uma frase) a ser falado. */
export interface SpeechSegment {
  /** texto falado (as posições do destaque são contadas neste texto) */
  speak: string;
  /** falado só no começo do trecho e sem destaque (ex.: "Concluído: ") */
  prefix?: string;
}

/** Onde a voz está agora: número do trecho e posição (em caracteres) dentro dele. */
export interface SpeechPosition {
  index: number;
  start: number;
  end: number;
}

/** true quando o app roda dentro do Android/iOS empacotado pelo Capacitor. */
const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const isWebSupported = (): boolean =>
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  "SpeechSynthesisUtterance" in window;

/** Chrome do Android (fora do app) ignora speak() logo depois de cancel(); o Safari NÃO pode esperar. */
const isAndroidWeb = (): boolean =>
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** No Android o idioma costuma vir como "pt_BR"; normaliza para comparar. */
const normLang = (lang: string | undefined) =>
  (lang || "").replace("_", "-").toLowerCase();

interface VoicePick {
  voice: SpeechSynthesisVoice | null;
  /** true quando sabemos que não há voz pt-BR utilizável */
  missingVoice: boolean;
}

function pickVoice(): VoicePick {
  const voices = window.speechSynthesis.getVoices();
  // Em alguns WebViews/Safari a lista vem vazia no começo: deixa o motor escolher pelo lang.
  if (voices.length === 0) return { voice: null, missingVoice: false };

  const ptbr = voices.filter((v) => normLang(v.lang) === "pt-br");
  const pool = ptbr.length > 0 ? ptbr : voices.filter((v) => normLang(v.lang).startsWith("pt"));

  const local = pool.find((v) => v.localService);
  if (local) return { voice: local, missingVoice: false };

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (pool.length > 0 && !offline) return { voice: pool[0], missingVoice: false };
  return { voice: null, missingVoice: true };
}

const MSG_VOICE_MISSING =
  "Voz em Português (Brasil) indisponível. No Android: Configurações > Sistema > Idioma > Saída de texto para fala > instale a voz pt-BR. No iPhone: Ajustes > Acessibilidade > Conteúdo Falado > Vozes > Português.";
const MSG_GENERIC_ERROR = "Não foi possível ler em voz alta agora.";
const MSG_BLOCKED = "O navegador bloqueou o áudio. Toque em ▶ de novo para ouvir.";

function loadRate(): number {
  try {
    const v = parseFloat(localStorage.getItem(RATE_KEY) || "");
    if (SPEECH_RATES.includes(v)) return v;
  } catch {
    /* sem storage */
  }
  return 1;
}

export function useSpeech() {
  const native = isNative();
  const supported = native || isWebSupported();
  const [speaking, setSpeaking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [position, setPosition] = useState<SpeechPosition | null>(null);
  const [finished, setFinished] = useState(false);
  const [rate, setRateState] = useState<number>(loadRate);

  const runRef = useRef(0); // invalida callbacks de leituras antigas
  const segsRef = useRef<SpeechSegment[]>([]);
  const rateRef = useRef(rate);
  const indexRef = useRef(0); // trecho atual
  const baseRef = useRef(0); // converte posição do motor de voz -> posição no texto mostrado
  const boundarySeenRef = useRef(false); // o motor de voz está avisando cada palavra?
  const estTimerRef = useRef<number | null>(null);
  const uttRef = useRef<SpeechSynthesisUtterance | null>(null); // evita o Safari "esquecer" a fala
  const runFromRef = useRef<(index: number, startChar: number, myRun: number) => void>(() => {});

  // Força o carregamento da lista de vozes no navegador (alguns aparelhos carregam tarde).
  useEffect(() => {
    if (native || !isWebSupported()) return;
    try {
      window.speechSynthesis.getVoices();
    } catch {
      /* ignora */
    }
  }, [native]);

  const clearEstimator = useCallback(() => {
    if (estTimerRef.current !== null) {
      window.clearInterval(estTimerRef.current);
      estTimerRef.current = null;
    }
  }, []);

  /**
   * Plano B do destaque: se o aparelho não avisa qual palavra está sendo falada,
   * estimamos a posição pelo tempo decorrido e pela velocidade.
   */
  const startEstimator = useCallback(
    (myRun: number, index: number, startChar: number, prefixLen: number, textLen: number) => {
      clearEstimator();
      const t0 = Date.now();
      estTimerRef.current = window.setInterval(() => {
        if (runRef.current !== myRun) {
          clearEstimator();
          return;
        }
        if (boundarySeenRef.current) return; // o aparelho está avisando de verdade
        const elapsed = Date.now() - t0;
        if (elapsed < 900) return; // dá tempo do aviso real chegar
        const charsSpoken = ((elapsed - 400) / 1000) * 14 * rateRef.current;
        const pos = Math.min(startChar + Math.max(0, Math.floor(charsSpoken - prefixLen)), startChar + textLen - 1);
        setPosition({ index, start: pos, end: pos });
      }, 150);
    },
    [clearEstimator]
  );

  const stop = useCallback(() => {
    runRef.current += 1;
    clearEstimator();
    if (isNative()) {
      TextToSpeech.stop().catch(() => {
        /* ignora */
      });
    } else if (isWebSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignora */
      }
    }
    setSpeaking(false);
  }, [clearEstimator]);

  // Para a fala ao sair da tela.
  useEffect(() => stop, [stop]);

  // Android (app instalado): enquanto a voz lê, mantém um serviço em primeiro plano (notificação
  // fixa) para o Android não congelar nem fechar o app com a tela bloqueada. O tempo estimado de
  // leitura (com folga) serve de trava: se algo der errado, o serviço se desliga sozinho.
  // O desligar espera um instante (e é cancelado se a voz voltar logo): tocar em pausar/tocar
  // várias vezes seguidas não pode ligar e desligar o serviço em sequência.
  const svcOnRef = useRef(false);
  const svcTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!native) return;
    if (svcTimerRef.current !== undefined) {
      window.clearTimeout(svcTimerRef.current);
      svcTimerRef.current = undefined;
    }
    if (speaking) {
      const chars = segsRef.current.reduce((sum, s) => sum + (s.prefix?.length ?? 0) + s.speak.length, 0);
      const seconds = Math.ceil((chars / (14 * Math.max(0.5, rate))) * 1.5) + 180;
      startReadAloudService(seconds);
      svcOnRef.current = true;
      return;
    }
    if (!svcOnRef.current) return; // nunca ligou: não há o que desligar
    svcTimerRef.current = window.setTimeout(() => {
      svcTimerRef.current = undefined;
      svcOnRef.current = false;
      stopReadAloudService();
    }, 1500);
  }, [native, speaking, rate]);
  useEffect(
    () => () => {
      if (svcTimerRef.current !== undefined) window.clearTimeout(svcTimerRef.current);
      if (native && svcOnRef.current) stopReadAloudService();
    },
    [native]
  );

  // Android (app instalado): o plugin avisa qual trecho está sendo falado.
  useEffect(() => {
    if (!native) return;
    let handle: { remove?: () => Promise<void> } | null = null;
    let cancelled = false;
    try {
      const p = (TextToSpeech as any).addListener?.("onRangeStart", (info: { start: number; end: number }) => {
        boundarySeenRef.current = true;
        const base = baseRef.current;
        setPosition({
          index: indexRef.current,
          start: Math.max(0, info.start + base),
          end: Math.max(0, info.end + base),
        });
      });
      Promise.resolve(p)
        .then((h) => {
          if (cancelled) h?.remove?.();
          else handle = h;
        })
        .catch(() => {
          /* versão do plugin sem esse aviso: usa o plano B */
        });
    } catch {
      /* ignora */
    }
    return () => {
      cancelled = true;
      handle?.remove?.();
    };
  }, [native]);

  const handleError = useCallback(
    (myRun: number, code: string) => {
      if (runRef.current !== myRun) return;
      runRef.current += 1;
      clearEstimator();
      try {
        if (isNative()) {
          // Para também o que já estava na fila do motor de voz do celular.
          TextToSpeech.stop().catch(() => {
            /* ignora */
          });
        } else if (isWebSupported()) {
          window.speechSynthesis.cancel();
        }
      } catch {
        /* ignora */
      }
      setSpeaking(false);
      if (code === "not-allowed") setMessage(MSG_BLOCKED);
      else if (code === "language-unavailable" || code === "voice-unavailable") setMessage(MSG_VOICE_MISSING);
      else setMessage(MSG_GENERIC_ERROR);
    },
    [clearEstimator]
  );

  /**
   * Android (app instalado): monta o "plano" de trechos a falar a partir de `index` e manda
   * para o motor de voz do celular em FILA (até FILA_NATIVA trechos à frente). Se a tela
   * bloquear e o app ficar congelado, o motor continua lendo a fila sozinho. Cada vez que um
   * trecho termina, o app atualiza o destaque e completa a fila.
   */
  const nativeRunFrom = useCallback(
    (index: number, startChar: number, myRun: number) => {
      if (runRef.current !== myRun) return;
      const segs = segsRef.current;

      const plano: { index: number; startChar: number; prefixLen: number; text: string }[] = [];
      for (let i = index; i < segs.length; i++) {
        const sc = i === index ? startChar : 0;
        const seg = segs[i];
        const body = seg.speak.slice(sc);
        if (!body.trim()) continue;
        const prefix = sc === 0 ? seg.prefix ?? "" : "";
        plano.push({ index: i, startChar: sc, prefixLen: prefix.length, text: prefix + body });
      }

      if (plano.length === 0) {
        clearEstimator();
        setSpeaking(false);
        setFinished(true);
        return;
      }

      let enfileirados = 0; // quantos já foram mandados ao motor de voz
      let concluidos = 0; // quantos o motor de voz já terminou de falar

      // Marca o trecho `n` do plano como o que está sendo falado agora.
      const apontar = (n: number) => {
        const p = plano[n];
        indexRef.current = p.index;
        baseRef.current = p.startChar - p.prefixLen; // posição no motor + base = posição no texto mostrado
        boundarySeenRef.current = false;
        setPosition({ index: p.index, start: p.startChar, end: p.startChar });
        startEstimator(myRun, p.index, p.startChar, p.prefixLen, p.text.length - p.prefixLen);
      };

      const enfileirar = () => {
        while (enfileirados < plano.length && enfileirados - concluidos < FILA_NATIVA) {
          const n = enfileirados++;
          TextToSpeech.speak({
            text: plano[n].text,
            lang: LANG,
            rate: rateRef.current,
            pitch: 1.0,
            volume: 1.0,
            category: "ambient",
            // O primeiro trecho começa do zero (interrompe qualquer fala anterior);
            // os outros entram na fila, um depois do outro.
            queueStrategy: n === 0 ? QueueStrategy.Flush : QueueStrategy.Add,
          })
            .then(() => {
              if (runRef.current !== myRun) return; // foi cancelada de propósito
              concluidos = Math.max(concluidos, n + 1);
              if (concluidos >= plano.length) {
                clearEstimator();
                setSpeaking(false);
                setFinished(true);
                return;
              }
              apontar(concluidos);
              enfileirar();
            })
            .catch((err) => {
              if (runRef.current !== myRun) return; // foi cancelada de propósito
              const txt = String((err as { message?: string })?.message ?? err).toLowerCase();
              handleError(myRun, txt.includes("lang") || txt.includes("voice") ? "voice-unavailable" : "error");
            });
        }
      };

      apontar(0);
      enfileirar();
    },
    [clearEstimator, startEstimator, handleError]
  );

  /** Fala o trecho `index` (a partir do caractere `startChar`) e encadeia os próximos. */
  const runFrom = useCallback(
    (index: number, startChar: number, myRun: number) => {
      if (runRef.current !== myRun) return;

      // Android (app instalado): fila no motor de voz do celular (ver nativeRunFrom).
      if (native) {
        nativeRunFrom(index, startChar, myRun);
        return;
      }

      const segs = segsRef.current;
      if (index >= segs.length) {
        clearEstimator();
        setSpeaking(false);
        setFinished(true);
        return;
      }

      const seg = segs[index];
      const body = seg.speak.slice(startChar);
      if (!body.trim()) {
        runFromRef.current(index + 1, 0, myRun);
        return;
      }

      const prefix = startChar === 0 ? seg.prefix ?? "" : "";
      const text = prefix + body;
      const base = startChar - prefix.length; // posição no motor + base = posição no texto mostrado
      baseRef.current = base;
      indexRef.current = index;
      boundarySeenRef.current = false;
      setPosition({ index, start: startChar, end: startChar });
      startEstimator(myRun, index, startChar, prefix.length, body.length);

      const goNext = () => {
        if (runRef.current !== myRun) return;
        clearEstimator();
        runFromRef.current(index + 1, 0, myRun);
      };

      // Navegador / PWA / Safari
      try {
        const synth = window.speechSynthesis;
        const { voice, missingVoice } = pickVoice();
        if (missingVoice && index === 0) setMessage(MSG_VOICE_MISSING);

        const u = new SpeechSynthesisUtterance(text);
        u.lang = LANG;
        if (voice) u.voice = voice;
        u.rate = rateRef.current;
        u.pitch = 1;
        u.onboundary = (e: SpeechSynthesisEvent) => {
          if (runRef.current !== myRun) return;
          if (e.name && e.name !== "word") return;
          boundarySeenRef.current = true;
          const at = Math.max(startChar, e.charIndex + base);
          setPosition({ index, start: at, end: at + (e.charLength || 0) });
        };
        u.onend = goNext;
        u.onerror = (e: SpeechSynthesisErrorEvent) => {
          if (runRef.current !== myRun) return;
          if (e.error === "canceled" || e.error === "interrupted") return;
          handleError(myRun, e.error);
        };
        uttRef.current = u; // mantém uma referência até terminar (senão o Safari pode calar no meio)
        synth.speak(u);
      } catch {
        handleError(myRun, "error");
      }
    },
    [native, nativeRunFrom, clearEstimator, startEstimator, handleError]
  );
  runFromRef.current = runFrom;

  /** Começa (ou recomeça) a leitura no trecho/caractere indicados. */
  const startAt = useCallback(
    (index: number, startChar: number) => {
      const myRun = ++runRef.current;
      clearEstimator();
      setSpeaking(true);
      setFinished(false);
      setMessage(null);

      if (native) {
        // Interrompe qualquer fala anterior antes de começar a nova.
        TextToSpeech.stop()
          .catch(() => {
            /* ignora */
          })
          .finally(() => {
            if (runRef.current === myRun) runFrom(index, startChar, myRun);
          });
        return;
      }

      try {
        const synth = window.speechSynthesis;
        if (synth.speaking || synth.pending) synth.cancel();
      } catch {
        /* ignora */
      }
      if (isAndroidWeb()) {
        // Alguns Androids ignoram speak() logo após cancel(); um respiro curto resolve.
        window.setTimeout(() => {
          if (runRef.current === myRun) runFrom(index, startChar, myRun);
        }, 80);
      } else {
        // Safari/iPhone: a fala TEM que começar dentro do toque do usuário, sem esperar nada.
        runFrom(index, startChar, myRun);
      }
    },
    [native, clearEstimator, runFrom]
  );

  /** Lê uma lista de trechos a partir de `startIndex`. Chame direto de um toque/clique. */
  const playSegments = useCallback(
    (segments: SpeechSegment[], startIndex = 0, startChar = 0): boolean => {
      setMessage(null);
      if (!supported) {
        setMessage("A leitura em voz alta não está disponível neste aparelho.");
        return false;
      }
      if (segments.length === 0) {
        setMessage("Esta nota não tem texto para ler.");
        return false;
      }
      segsRef.current = segments;
      const idx = Math.max(0, Math.min(segments.length - 1, startIndex));
      indexRef.current = idx;
      startAt(idx, idx === startIndex ? startChar : 0);
      return true;
    },
    [supported, startAt]
  );

  /** Vai para outro trecho/palavra. Com `autoplay` falso só move o marcador (leitura parada). */
  const jumpTo = useCallback(
    (index: number, startChar = 0, autoplay = true) => {
      const segs = segsRef.current;
      if (segs.length === 0) return;
      const idx = Math.max(0, Math.min(segs.length - 1, index));
      indexRef.current = idx;
      if (autoplay) {
        startAt(idx, startChar);
      } else {
        stop();
        setFinished(false);
        setPosition({ index: idx, start: startChar, end: startChar });
      }
    },
    [startAt, stop]
  );

  /** Continua de onde parou (do começo da frase atual; se a nota acabou, recomeça). */
  const resume = useCallback(() => {
    const segs = segsRef.current;
    if (segs.length === 0) return;
    const idx = finished ? 0 : Math.min(indexRef.current, segs.length - 1);
    startAt(idx, 0);
  }, [finished, startAt]);

  const setRate = useCallback(
    (r: number) => {
      if (!SPEECH_RATES.includes(r)) return;
      rateRef.current = r;
      setRateState(r);
      try {
        localStorage.setItem(RATE_KEY, String(r));
      } catch {
        /* sem storage */
      }
      // Se está falando, recomeça a frase atual já na nova velocidade.
      if (speaking) startAt(indexRef.current, 0);
    },
    [speaking, startAt]
  );

  /** Modo antigo: lê um texto corrido (sem destaque). Continua funcionando como antes. */
  const speak = useCallback(
    (rawText: string): boolean => {
      setMessage(null);
      if (!supported) {
        setMessage("A leitura em voz alta não está disponível neste aparelho.");
        return false;
      }
      const text = prepareForSpeech(rawText);
      if (!text) {
        setMessage("Esta nota não tem texto para ler.");
        return false;
      }
      return playSegments(splitForSpeech(text).map((c) => ({ speak: c })));
    },
    [supported, playSegments]
  );

  const toggle = useCallback(
    (text: string) => {
      if (speaking) stop();
      else speak(text);
    },
    [speaking, speak, stop]
  );

  const clearMessage = useCallback(() => setMessage(null), []);

  return {
    supported,
    speaking,
    message,
    position,
    finished,
    rate,
    speak,
    stop,
    toggle,
    clearMessage,
    playSegments,
    jumpTo,
    resume,
    setRate,
  };
}
