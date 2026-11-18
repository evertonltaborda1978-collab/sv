/**
 * Leitura acompanhada — transforma a nota (título, textos com negrito, listas, checklists e
 * Tabela Manual) numa lista de FRASES, cada uma com suas PALAVRAS e posições.
 *
 * Por que frases? Ler uma frase por vez é o jeito mais confiável de a voz funcionar em todos os
 * aparelhos (Android e Safari/iPhone) e dá um ponto exato para "voltar", "avançar" e "continuar
 * daqui" ao tocar numa palavra.
 */

export type ReadKind = "title" | "heading" | "text" | "list" | "check" | "table";

export interface ReadWord {
  /** posição inicial da palavra dentro de `text` */
  s: number;
  /** posição final (exclusiva) */
  e: number;
  bold: boolean;
}

export interface ReadSentence {
  id: number;
  /** texto mostrado na tela */
  text: string;
  /** texto enviado para a voz (mesmo tamanho de `text`; links viram "link") */
  speak: string;
  /** falado antes da frase (ex.: "Concluído: "), não aparece no destaque */
  prefix: string;
  words: ReadWord[];
  kind: ReadKind;
  /** marcador visual do parágrafo (•, 1., ☐, ☑) — só na primeira frase do parágrafo */
  marker?: string;
  checked?: boolean;
  /** número do parágrafo a que a frase pertence */
  para: number;
  /** true na primeira frase do parágrafo */
  paraStart: boolean;
}

export interface ReadDoc {
  sentences: ReadSentence[];
}

/** Bloco da nota já preparado pelo editor (veja NoteEditor.tsx). */
export interface ReadBlockInput {
  type: string;
  content?: string;
  /** HTML do texto rico (com negrito), já validado */
  html?: string;
  items?: { text: string; checked: boolean; bold?: boolean }[];
  rows?: { nome: string; valor: string }[];
}

interface Para {
  text: string;
  bold: boolean[];
  kind: ReadKind;
  marker?: string;
  checked?: boolean;
  prefix?: string;
}

const MAX_SENTENCE = 220;
const MIN_CUT = 90;
const ABBREV = /^(\d{1,3}|[A-Za-zÀ-ÿ]|dr|dra|sr|sra|prof|profa|av|pág|obs|art|nº|cap)\.$/i;

// ── 1) Extrai parágrafos (texto + negrito por caractere) ─────────────────────────

const BLOCK_TAGS = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR"]);

function isBoldStyle(el: HTMLElement): boolean {
  const fw = el.style?.fontWeight;
  if (!fw) return false;
  if (fw === "bold" || fw === "bolder") return true;
  const n = parseInt(fw, 10);
  return !isNaN(n) && n >= 600;
}

function parasFromHtml(html: string): { text: string; bold: boolean[] }[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  const paras: { text: string; bold: boolean[] }[] = [];
  let cur: { text: string; bold: boolean[] } = { text: "", bold: [] };
  const flush = () => {
    paras.push(cur);
    cur = { text: "", bold: [] };
  };

  const walk = (node: Node, bold: boolean) => {
    if (node.nodeType === 3) {
      const parts = (node.textContent || "").replace(/\u00a0/g, " ").split("\n");
      parts.forEach((p, i) => {
        if (i > 0) flush();
        if (!p) return;
        cur.text += p;
        for (let k = 0; k < p.length; k++) cur.bold.push(bold);
      });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === "BR") {
      flush();
      return;
    }
    const b = bold || tag === "B" || tag === "STRONG" || /^H[1-6]$/.test(tag) || isBoldStyle(el);
    const block = BLOCK_TAGS.has(tag);
    if (block && cur.text.length > 0) flush();
    el.childNodes.forEach((c) => walk(c, b));
    if (block && cur.text.length > 0) flush();
  };

  root.childNodes.forEach((c) => walk(c, false));
  if (cur.text.length > 0) paras.push(cur);
  return paras;
}

function parasFromPlain(text: string): { text: string; bold: boolean[] }[] {
  return text.split(/\r?\n/).map((line) => ({ text: line, bold: new Array(line.length).fill(false) }));
}

// ── 2) Limpeza: espaços, marcadores de lista/título e **negrito** em texto simples ──

function slice(p: { text: string; bold: boolean[] }, from: number) {
  return { text: p.text.slice(from), bold: p.bold.slice(from) };
}

function normalizeSpaces(p: { text: string; bold: boolean[] }) {
  let text = "";
  const bold: boolean[] = [];
  let lastSpace = true; // descarta espaços do início
  for (let i = 0; i < p.text.length; i++) {
    let ch = p.text[i];
    if (ch === "\t" || ch === "\u200B" || ch === "\uFEFF") ch = ch === "\t" ? " " : "";
    if (!ch) continue;
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      text += " ";
      bold.push(p.bold[i]);
      lastSpace = true;
    } else {
      text += ch;
      bold.push(p.bold[i]);
      lastSpace = false;
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    bold.pop();
  }
  return { text, bold };
}

/** Tira **negrito**, __negrito__, `código` e * soltos; o trecho entre ** ** vira negrito de verdade. */
function stripInlineMarkdown(p: { text: string; bold: boolean[] }) {
  let text = "";
  const bold: boolean[] = [];
  let md = false;
  for (let i = 0; i < p.text.length; i++) {
    const two = p.text.substr(i, 2);
    if (two === "**" || two === "__") {
      md = !md;
      i += 1;
      continue;
    }
    const ch = p.text[i];
    if (ch === "`" || ch === "*") continue;
    text += ch;
    bold.push(p.bold[i] || md);
  }
  return normalizeSpaces({ text, bold });
}

function buildPara(raw: { text: string; bold: boolean[] }): Para | null {
  let p = normalizeSpaces(raw);
  if (!p.text) return null;
  let kind: ReadKind = "text";
  let marker: string | undefined;

  const h = p.text.match(/^#{1,6}\s+/);
  if (h) {
    p = slice(p, h[0].length);
    kind = "heading";
  } else {
    const li = p.text.match(/^(?:([-*•–])|(\d{1,3}[.)]))\s+/);
    if (li) {
      marker = li[1] ? "•" : li[2];
      p = slice(p, li[0].length);
      kind = "list";
    }
  }

  p = stripInlineMarkdown(p);
  if (!p.text) return null;

  // Linha curta toda em negrito, sem ponto final = título de seção
  if (kind === "text" && p.text.length <= 90 && p.bold.every(Boolean) && !/[.!?…:]$/.test(p.text)) {
    kind = "heading";
  }
  return { ...p, kind, marker };
}

// ── 3) Divide em frases ──────────────────────────────────────────────────────────

function pushTrim(text: string, a: number, b: number, out: [number, number][]) {
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (b > a) out.push([a, b]);
}

function splitLong(text: string, a: number, b: number, out: [number, number][]) {
  let s = a;
  while (b - s > MAX_SENTENCE) {
    const win = text.slice(s, s + MAX_SENTENCE);
    let cut = -1;
    for (let k = win.length - 1; k >= MIN_CUT; k--) {
      const c = win[k];
      if ((c === "," || c === ";" || c === ":") && win[k + 1] === " ") {
        cut = k + 1;
        break;
      }
    }
    if (cut < 0) {
      cut = win.lastIndexOf(" ");
      if (cut < MIN_CUT) cut = MAX_SENTENCE;
    }
    pushTrim(text, s, s + cut, out);
    s += cut;
  }
  pushTrim(text, s, b, out);
}

export function splitSentenceRanges(text: string): [number, number][] {
  const raw: [number, number][] = [];
  const n = text.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "…") {
      let j = i + 1;
      while (j < n && /[.!?…"'”’)\]]/.test(text[j])) j++;
      const atEnd = j >= n || /\s/.test(text[j]);
      if (atEnd) {
        if (ch === "." && j === i + 1) {
          const tokStart = text.lastIndexOf(" ", i) + 1;
          if (ABBREV.test(text.slice(tokStart, i + 1))) {
            i = j;
            continue;
          }
        }
        pushTrim(text, start, j, raw);
        start = j;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < n) pushTrim(text, start, n, raw);

  const out: [number, number][] = [];
  raw.forEach(([a, b]) => splitLong(text, a, b, out));
  return out;
}

/** Palavras curtas em português que, em MAIÚSCULAS, a voz soletra (DE vira "dê é"). */
const SMALL_WORDS = new Set([
  "A", "E", "O", "AS", "OS", "DE", "DA", "DO", "DAS", "DOS", "EM", "NA", "NO", "NAS", "NOS",
  "UM", "UMA", "OU", "AO", "AOS", "COM", "POR", "PARA", "SEM", "QUE", "SE", "MAIS", "MAS", "É",
]);

/**
 * As vozes do celular soletram palavras escritas só em MAIÚSCULAS (tratam como sigla).
 * Aqui passamos para minúsculas só o que vai para a voz — a tela continua igual.
 * Siglas curtas (PDF, SQL, CLP) continuam sendo soletradas.
 */
function softenCaps(text: string): string {
  const letters = text.match(/\p{L}/gu) || [];
  const upper = letters.filter((c) => c !== c.toLowerCase()).length;
  const mostlyCaps = letters.length >= 4 && upper / letters.length >= 0.7;

  const out = text.replace(/\p{L}+/gu, (w) => {
    if (w === w.toLowerCase() || w !== w.toUpperCase()) return w; // já tem minúscula
    const lower = w.toLowerCase();
    if (lower.length !== w.length) return w;
    if (mostlyCaps || w.length >= 5 || SMALL_WORDS.has(w)) return lower;
    return w; // sigla curta: PDF, SQL, NR12...
  });
  return out.length === text.length ? out : text;
}

function toSpeak(text: string): string {
  // Link vira "link" (mesmo tamanho do original, para o destaque continuar alinhado)
  return softenCaps(text.replace(/https?:\/\/\S+/gi, (m) => "link".padEnd(m.length, " ")));
}

// ── 4) Monta o documento completo ────────────────────────────────────────────────

export function buildReadDoc(title: string, blocks: ReadBlockInput[]): ReadDoc {
  const paras: Para[] = [];

  const addPlainPara = (text: string, kind: ReadKind, extra: Partial<Para> = {}, bold = false) => {
    const p = normalizeSpaces({ text, bold: new Array(text.length).fill(bold) });
    if (p.text) paras.push({ ...p, kind, ...extra });
  };

  if (title && title.trim()) addPlainPara(title, "title", {}, true);

  for (const b of blocks) {
    if (b.type === "text") {
      const raw = b.html ? parasFromHtml(b.html) : parasFromPlain(b.content || "");
      raw.forEach((r) => {
        const p = buildPara(r);
        if (p) paras.push(p);
      });
    } else if (b.type === "checklist" && b.items) {
      b.items.forEach((it) => {
        if (!it.text?.trim()) return;
        addPlainPara(
          it.text,
          "check",
          { marker: it.checked ? "☑" : "☐", checked: it.checked, prefix: it.checked ? "Concluído: " : "Pendente: " },
          !!it.bold
        );
      });
    } else if (b.type === "table" && b.rows) {
      b.rows.forEach((r) => {
        if (!r.nome?.trim()) return;
        addPlainPara(`${r.nome.trim()}: ${r.valor}`, "table");
      });
    }
  }

  const sentences: ReadSentence[] = [];
  paras.forEach((p, paraIdx) => {
    const ranges = splitSentenceRanges(p.text);
    ranges.forEach(([a, b], k) => {
      const text = p.text.slice(a, b);
      const boldSlice = p.bold.slice(a, b);
      const words: ReadWord[] = [];
      const re = /\S+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const s = m.index;
        const e = s + m[0].length;
        let nb = 0;
        for (let x = s; x < e; x++) if (boldSlice[x]) nb++;
        words.push({ s, e, bold: nb > (e - s) / 2 });
      }
      if (words.length === 0) return;
      sentences.push({
        id: sentences.length,
        text,
        speak: toSpeak(text),
        prefix: k === 0 ? p.prefix || "" : "",
        words,
        kind: p.kind,
        marker: k === 0 ? p.marker : undefined,
        checked: p.checked,
        para: paraIdx,
        paraStart: k === 0,
      });
    });
  });

  return { sentences };
}

/** Índice da palavra que contém (ou vem logo antes de) a posição `pos` da frase. */
export function wordIndexAt(s: ReadSentence, pos: number): number {
  let idx = 0;
  for (let i = 0; i < s.words.length; i++) {
    if (s.words[i].s <= pos) idx = i;
    else break;
  }
  return idx;
}
