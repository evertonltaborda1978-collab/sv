import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import { prepareForSpeech, splitForSpeech } from "@/lib/noteText";

const LANG = "pt-BR";

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

/** No Android o idioma costuma vir como "pt_BR"; normaliza para comparar. */
const normLang = (lang: string | undefined) =>
  (lang || "").replace("_", "-").toLowerCase();

interface VoicePick {
  voice: SpeechSynthesisVoice | null;
  /** true quando sabemos que não há voz pt-BR utilizável offline */
  missingOfflineVoice: boolean;
}

function pickVoice(): VoicePick {
  const voices = window.speechSynthesis.getVoices();
  // Em alguns WebViews a lista vem vazia: deixa o motor escolher pelo lang.
  if (voices.length === 0) return { voice: null, missingOfflineVoice: false };

  const ptbr = voices.filter((v) => normLang(v.lang) === "pt-br");
  const local = ptbr.find((v) => v.localService);
  if (local) return { voice: local, missingOfflineVoice: false };

  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (ptbr.length > 0 && !offline) {
    return { voice: ptbr[0], missingOfflineVoice: false };
  }
  return { voice: null, missingOfflineVoice: true };
}

const MSG_VOICE_MISSING =
  "Voz em Português (Brasil) indisponível. No Android: Configurações > Sistema > Idioma > Saída de texto para fala > instale a voz pt-BR.";
const MSG_GENERIC_ERROR = "Não foi possível ler em voz alta agora.";

export function useSpeech() {
  const native = isNative();
  const supported = native || isWebSupported();
  const [speaking, setSpeaking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const runRef = useRef(0); // invalida callbacks de leituras antigas

  // Força o carregamento da lista de vozes no navegador (alguns aparelhos carregam tarde).
  useEffect(() => {
    if (native || !isWebSupported()) return;
    try {
      window.speechSynthesis.getVoices();
    } catch {
      /* ignora */
    }
  }, [native]);

  const stop = useCallback(() => {
    runRef.current += 1;
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
  }, []);

  // Para a fala ao sair da nota.
  useEffect(() => stop, [stop]);

  /** Leitura pelo motor de voz nativo do Android (plugin do Capacitor). */
  const speakNative = useCallback((chunks: string[], myRun: number) => {
    setSpeaking(true);

    void (async () => {
      try {
        for (const chunk of chunks) {
          if (runRef.current !== myRun) return;
          // speak() só resolve quando o trecho termina de ser falado.
          await TextToSpeech.speak({
            text: chunk,
            lang: LANG,
            rate: 1.0,
            pitch: 1.0,
            volume: 1.0,
            category: "ambient",
          });
        }
        if (runRef.current === myRun) setSpeaking(false);
      } catch (err) {
        if (runRef.current !== myRun) return; // foi cancelada de propósito
        runRef.current += 1;
        setSpeaking(false);
        const txt = String((err as { message?: string })?.message ?? err).toLowerCase();
        setMessage(
          txt.includes("language") || txt.includes("lang") || txt.includes("voice")
            ? MSG_VOICE_MISSING
            : MSG_GENERIC_ERROR
        );
      }
    })();
  }, []);

  /** Leitura pelo speechSynthesis do navegador (PWA / computador). */
  const speakWeb = useCallback((chunks: string[], myRun: number) => {
    const synth = window.speechSynthesis;

    // Limpa a fila antes de falar.
    try {
      synth.cancel();
    } catch {
      /* ignora */
    }

    const { voice, missingOfflineVoice } = pickVoice();
    if (missingOfflineVoice) {
      setMessage(
        "Sem voz em Português (Brasil) instalada para uso offline. No Android: Configurações > Idioma > Saída de texto para fala > baixe a voz pt-BR."
      );
    }

    setSpeaking(true);

    // Alguns Androids ignoram speak() logo após cancel(); um respiro curto resolve.
    window.setTimeout(() => {
      if (runRef.current !== myRun) return;
      chunks.forEach((chunk, idx) => {
        const u = new SpeechSynthesisUtterance(chunk);
        u.lang = LANG;
        if (voice) u.voice = voice;
        u.rate = 1;
        u.pitch = 1;

        if (idx === chunks.length - 1) {
          u.onend = () => {
            if (runRef.current === myRun) setSpeaking(false);
          };
        }
        u.onerror = (e) => {
          if (runRef.current !== myRun) return;
          if (e.error === "canceled" || e.error === "interrupted") return;
          runRef.current += 1;
          try {
            synth.cancel();
          } catch {
            /* ignora */
          }
          setSpeaking(false);
          setMessage(
            e.error === "language-unavailable" || e.error === "voice-unavailable"
              ? MSG_VOICE_MISSING
              : MSG_GENERIC_ERROR
          );
        };

        try {
          synth.speak(u);
        } catch {
          if (runRef.current === myRun) {
            setSpeaking(false);
            setMessage(MSG_GENERIC_ERROR);
          }
        }
      });
    }, 80);
  }, []);

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

      const chunks = splitForSpeech(text);
      const myRun = ++runRef.current;

      if (native) {
        // Interrompe qualquer fala anterior antes de começar a nova.
        TextToSpeech.stop()
          .catch(() => {
            /* ignora */
          })
          .finally(() => {
            if (runRef.current === myRun) speakNative(chunks, myRun);
          });
      } else {
        speakWeb(chunks, myRun);
      }

      return true;
    },
    [supported, native, speakNative, speakWeb]
  );

  const toggle = useCallback(
    (text: string) => {
      if (speaking) stop();
      else speak(text);
    },
    [speaking, speak, stop]
  );

  const clearMessage = useCallback(() => setMessage(null), []);

  return { supported, speaking, message, speak, stop, toggle, clearMessage };
}
