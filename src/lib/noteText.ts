/**
 * Utilitários para transformar o conteúdo de uma nota em texto limpo.
 * Usado pela Leitura Limpa e pela leitura em voz alta.
 */

/** Converte o HTML da nota em texto puro, preservando quebras de linha. */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  // Marcadores invisíveis (<!--relatorio-...-->) são comentários HTML e
  // não entram no textContent, então somem sozinhos aqui.
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  const doc = new DOMParser().parseFromString(withBreaks, "text/html");
  return (doc.body.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Remove emojis e símbolos que o sintetizador leria como "marca de verificação" etc. */
export function prepareForSpeech(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, "")
    .replace(/[•▪◦●]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Divide o texto em pedaços curtos. Vozes locais do Android costumam
 * falhar ou parar em textos longos; pedaços de ~180 caracteres são seguros.
 */
export function splitForSpeech(text: string, max = 180): string[] {
  const pieces = text
    .split(/(?<=[.!?;:\n])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const piece of pieces) {
    if (piece.length > max) {
      flush();
      let line = "";
      for (const word of piece.split(/\s+/)) {
        if ((line + " " + word).trim().length > max) {
          if (line) chunks.push(line);
          line = word;
        } else {
          line = (line + " " + word).trim();
        }
      }
      if (line) chunks.push(line);
    } else if ((current + " " + piece).trim().length > max) {
      flush();
      current = piece;
    } else {
      current = (current + " " + piece).trim();
    }
  }
  flush();
  return chunks;
}
