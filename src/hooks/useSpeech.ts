import { useCallback, useEffect, useRef, useState } from "react";
import { prepareForSpeech, splitForSpeech } from "@/lib/noteText";

const LANG = "pt-BR";

const isSupported = (): boolean =>
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

export function useSpeech() {
  const supported = isSupported();
  const [speaking, setSpeaking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const runRef = useRef(0); // invalida callbacks de leituras antigas

  // Força o carregamento da lista de vozes (alguns aparelhos carregam tarde).
  useEffect(() => {
    if (!supported) return;
    try {
      window.speechSynthesis.getVoices();
    } catch {
      /* ignora */
    }
  }, [supported]);

  const stop = useCallback(() => {
    runRef.current += 1;
    if (isSupported()) {
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

  const speak = useCallback((rawText: string): boolean => {
    setMessage(null);

    if (!isSupported()) {
      setMessage("A leitura em voz alta não está disponível neste aparelho.");
      return false;
    }

    const text = prepareForSpeech(rawText);
    if (!text) {
      setMessage("Esta nota não tem texto para ler.");
      return false;
    }

    const synth = window.speechSynthesis;
    const myRun = ++runRef.current;

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

    const chunks = splitForSpeech(text);
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
              ? "Voz em Português (Brasil) indisponível. Instale-a nas configurações de texto para fala do Android."
              : "Não foi possível ler em voz alta agora."
          );
        };

        try {
          synth.speak(u);
        } catch {
          if (runRef.current === myRun) {
            setSpeaking(false);
            setMessage("Não foi possível ler em voz alta agora.");
          }
        }
      });
    }, 80);

    return true;
  }, []);

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
