import { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo, Component, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Note } from "@/hooks/useNotes";
import { takeNativePhoto, isNative } from "@/lib/native";
import { shareOrSaveImage, shareText } from "@/lib/nativeShare";
import {
  Camera,
  X,
  ImagePlus,
  Copy,
  Check,
  Undo2,
  Redo2,
  ScanSearch,
  Loader2,
  ScanLine,
  Mic,
  MicOff,
  ListChecks,
  Square,
  CheckSquare,
  CalendarPlus,
  Trash2,
  Pencil,
  Share2,
  Table2,
  Plus,
  ArrowUpRight,
  Minus,
  Circle,
  Type,
  Eraser,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  ChevronLeft,
  ChevronRight,
  Palette,
  Bold as BoldIcon,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Paintbrush,
  Crop,
  Scissors,
  Contrast,
  Volume2,
  VolumeX,
  BookOpen,
  Calculator,
  MoreHorizontal,
  Delete as BackspaceIcon,
  Keyboard,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
// VisuallyHidden replaced with sr-only span for compatibility
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "@/hooks/use-toast";
import { ALERT_SOUND_OPTIONS, playAlertSoundPreview, type AlertSoundId } from "@/lib/alertSound";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { consistentHtml } from "@/lib/richTextConsistency";
import { useSpeech } from "@/hooks/useSpeech";
import { ReadAlongView } from "@/components/ReadAlongView";
import { buildReadDoc, type ReadDoc } from "@/lib/readAlong";
import { evaluateExpression } from "@/lib/moneyCalc";

// ── Types ──────────────────────────────────────────────
export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  bold?: boolean;
}

export interface TableItem {
  id: string;
  nome: string;
  valor: string; // ex: "150", "-100", "-10%", "5%"
  marcado: boolean;
  // Só existe quando a calculadora 🧮 foi usada nesta linha. Digitar o valor direto apaga isto.
  calc?: { historico: { expressao: string; resultado: number }[] };
}

export interface TextStyle {
  color?: string;
  font?: string; // "default" | "serif" | "mono" | "hand"
  bold?: boolean;
  align?: "left" | "center" | "right";
}

export interface ContentBlock {
  type: "text" | "image" | "checklist" | "table";
  content?: string;
  contentHtml?: string; // versão com formatação por trecho (cor/negrito), gerada pelo editor rico
  url?: string;
  items?: ChecklistItem[];
  tableItems?: TableItem[];
  tableTitle?: string; // título editável da Tabela Manual (padrão: "Tabela Manual")
  somaTotalLabel?: string; // nome editável da barra "Soma Total" (guardado na 1ª tabela da nota)
  style?: TextStyle;
}

// Cores disponíveis pra formatação de texto
export const TEXT_COLORS = ["#1A1A2E", "#E53935", "#2D9E7F", "#1E88E5", "#F9A825", "#8E24AA", "#546E7A"];

// No modo noturno, as cores escuras do texto (vermelho, verde, azul, roxo, cinza) ficam apagadas
// no fundo escuro. Aqui cada uma ganha uma versão mais clara, só na exibição: a cor salva na nota
// não muda (volta ao normal no modo claro). O amarelo já é claro e fica como está.
// [como o navegador guarda a cor em rgb(...), em hex, versão clara]
const DARK_TEXT_COLOR_FIXES: Array<[string, string, string]> = [
  ["229, 57, 53", "#e53935", "#FF8A80"],
  ["45, 158, 127", "#2d9e7f", "#5FD3B3"],
  ["30, 136, 229", "#1e88e5", "#64B5F6"],
  ["142, 36, 170", "#8e24aa", "#CE93D8"],
  ["84, 110, 122", "#546e7a", "#B0BEC5"],
];
const DARK_TEXT_COLOR_CSS = DARK_TEXT_COLOR_FIXES.map(([rgb, hex, light]) =>
  [".rich-text-editable", ".note-rich-view"]
    .map((c) => `[data-note-dark="true"] ${c} [style*="${rgb}"], [data-note-dark="true"] ${c} [style*="${hex}" i]`)
    .join(", ") + ` { color: ${light} !important; }`
).join(" ");

// Famílias de fonte disponíveis (usando fontes seguras, sem precisar carregar nada extra)
export const FONT_OPTIONS: Record<string, { label: string; family: string }> = {
  default: { label: "Padrão", family: "inherit" },
  serif: { label: "Serifada", family: "Georgia, 'Times New Roman', serif" },
  mono: { label: "Monoespaçada", family: "'Courier New', monospace" },
  hand: { label: "Manuscrita", family: "'Comic Sans MS', 'Comic Sans', cursive" },
};

// ── Color theme map ────────────────────────────────────
const COLOR_THEMES: Record<string, { bg: string; lines: string; headerBg: string; toolbarBg: string; textMuted: string; borderAccent: string; text: string; card: string }> = {
  "bg-yellow-100": { bg: "#FFFDE7", lines: "#F0E68C", headerBg: "#F0E68C", toolbarBg: "#FFF9C4", textMuted: "#8B7E3C", borderAccent: "#D4C55A", text: "#3F3A1A", card: "#FFFFFF" },
  "bg-orange-100": { bg: "#FFE8D6", lines: "#FFBF9B", headerBg: "#FFBF9B", toolbarBg: "#FFECD2", textMuted: "#8B5E3C", borderAccent: "#E89B6B", text: "#4A2E18", card: "#FFFFFF" },
  "bg-purple-100": { bg: "#EDE7F6", lines: "#C9B8F0", headerBg: "#C9B8F0", toolbarBg: "#E8E0F4", textMuted: "#5E4B8B", borderAccent: "#B39DDB", text: "#2E2447", card: "#FFFFFF" },
  "bg-green-100": { bg: "#E8F5E9", lines: "#A5D6A7", headerBg: "#A5D6A7", toolbarBg: "#E0F2E1", textMuted: "#3C6B3E", borderAccent: "#81C784", text: "#1E3D20", card: "#FFFFFF" },
  "bg-pink-100": { bg: "#F3E5F5", lines: "#CE93D8", headerBg: "#CE93D8", toolbarBg: "#EFE0F3", textMuted: "#7B3C8B", borderAccent: "#BA68C8", text: "#42204A", card: "#FFFFFF" },
  "bg-blue-100": { bg: "#E3F2FD", lines: "#90CAF9", headerBg: "#90CAF9", toolbarBg: "#DCF0FC", textMuted: "#3C5E8B", borderAccent: "#64B5F6", text: "#1C3049", card: "#FFFFFF" },
  "bg-gray-800": { bg: "#2D2D2D", lines: "#444444", headerBg: "#444444", toolbarBg: "#333333", textMuted: "#AAAAAA", borderAccent: "#666666", text: "#F0F0F0", card: "#3A3A3A" },
  "bg-paper": { bg: "#F5F0E8", lines: "#D3CFC5", headerBg: "#EDE8DF", toolbarBg: "#EDE8DF", textMuted: "#7A7468", borderAccent: "#C5BFB5", text: "#3A362E", card: "#FFFFFF" },
};

const NOTE_COLORS = [
  { value: "bg-yellow-100", label: "Amarelo", dot: "#FEF9C3" },
  { value: "bg-blue-100", label: "Azul", dot: "#DBEAFE" },
  { value: "bg-green-100", label: "Verde", dot: "#DCFCE7" },
  { value: "bg-pink-100", label: "Rosa", dot: "#FCE7F3" },
  { value: "bg-orange-100", label: "Laranja", dot: "#FED7AA" },
  { value: "bg-purple-100", label: "Roxo", dot: "#E9D5FF" },
  { value: "bg-gray-800", label: "Escura", dot: "#1F2937" },
  { value: "bg-paper", label: "Papel", dot: "#F5F0E8" },
];

// ── Helpers ────────────────────────────────────────────
export function getFontClass(_f: string) { return "font-body"; }
export function getSizeClass(_f: string) { return "text-sm"; }

// Detect mobile browser
const isMobileBrowser = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// Renderiza texto com links clicáveis
function renderTextWithLinks(text: string, textColor: string, fontSize: number) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0;
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: "#E53935",
            textDecoration: "underline",
            fontSize: `${fontSize}px`,
            wordBreak: "break-all",
          }}
        >
          {part}
        </a>
      );
    }
    return <span key={i} style={{ color: textColor, fontSize: `${fontSize}px` }}>{part}</span>;
  });
}

// Transforma links "soltos" (http://...) dentro de um HTML de texto rico em
// <a> vermelho e sublinhado, automaticamente — sem precisar formatar na mão.
// Processa só o texto FORA de tags já existentes (nunca mexe dentro de uma
// <a> que já exista, pra não linkificar duas vezes).
function linkifyHtml(html: string): string {
  if (!html || !html.includes("http")) return html;
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  const parts = html.split(/(<[^>]+>)/g);
  let insideAnchor = false;
  return parts
    .map((part) => {
      if (part.startsWith("<")) {
        if (/^<a[\s>]/i.test(part)) insideAnchor = true;
        if (/^<\/a>/i.test(part)) insideAnchor = false;
        return part;
      }
      if (insideAnchor || !part) return part;
      return part.replace(urlRegex, (url) => {
        const trailingMatch = url.match(/[.,;:!?)\]]+$/);
        const trailing = trailingMatch ? trailingMatch[0] : "";
        const clean = trailing ? url.slice(0, -trailing.length) : url;
        return `<a href="${clean}" target="_blank" rel="noopener noreferrer" style="color:#E53935;text-decoration:underline;">${clean}</a>${trailing}`;
      });
    })
    .join("");
}

// Sanitize pasted text on mobile — strip HTML, invisible chars, incompatible line breaks
function handleMobilePaste(e: React.ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (!isMobileBrowser()) return; // Don't interfere on desktop
  const html = e.clipboardData.getData("text/html");
  const plain = e.clipboardData.getData("text/plain");
  // Only intercept if there's HTML or suspicious content
  if (!html && !plain) return;
  e.preventDefault();
  // Clean: strip HTML tags, normalize whitespace, remove zero-width chars
  let cleaned = (html ? html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]*>/g, "") : plain)
    .replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, " ") // zero-width & nbsp
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/ {3,}/g, "  ")
    .trim();
  // Decode HTML entities
  const textarea = document.createElement("textarea");
  textarea.innerHTML = cleaned;
  cleaned = textarea.value;
  // Insert at cursor position
  const target = e.currentTarget;
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  const before = target.value.substring(0, start);
  const after = target.value.substring(end);
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    "value"
  )?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(target, before + cleaned + after);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    // Set cursor position after pasted text
    const newPos = start + cleaned.length;
    target.setSelectionRange(newPos, newPos);
  }
}

// Limpeza de segurança básica do HTML gerado pelo editor de texto rico —
// como o conteúdo vem só do próprio navegador (execCommand), o risco é baixo,
// mas ainda removemos qualquer coisa perigosa por precaução.
function sanitizeRichHtml(html: string): string {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/ on\w+="[^"]*"/gi, "")
    .replace(/ on\w+='[^']*'/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/<(?!\/?(span|br|div|b|strong|i|em|u|a)\b)[^>]+>/gi, "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Converte texto simples (sem formatação ainda) em HTML seguro pra semear o editor rico
function textToHtml(text: string): string {
  return escapeHtml(text || "").replace(/\n/g, "<br>");
}

// Posiciona o cursor num contentEditable numa posição de caractere específica
// (equivalente ao setSelectionRange de uma textarea, que não existe em contentEditable)
function placeCaretAt(el: HTMLElement, offset: number) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let remaining = offset;
  let placed = false;

  function walk(node: Node) {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0;
      if (remaining <= len) {
        range.setStart(node, Math.max(0, remaining));
        placed = true;
      } else {
        remaining -= len;
      }
    } else {
      for (const child of Array.from(node.childNodes)) {
        walk(child);
        if (placed) return;
      }
    }
  }

  walk(el);
  if (!placed) {
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function htmlToPlainText(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html.replace(/<br\s*\/?>/gi, "\n");
  return tmp.textContent || "";
}

function serializeBlocks(blocks: ContentBlock[]): string {
  // Garante que links fiquem vermelhos/sublinhados ao salvar, mesmo se o
  // "sair do campo" (blur) não tiver disparado certinho em algum teclado
  // Android — rede de segurança extra além do onBlur de cada campo.
  // Também não grava a versão formatada quando ela não bate com o texto simples
  // (ex.: texto repetido por causa do teclado): assim a repetição nunca é salva
  // e não aparece ao abrir a nota em outro aparelho.
  const withLinks = blocks.map((b) => {
    if (!b.contentHtml) return b;
    const ok = consistentHtml(b);
    return ok ? { ...b, contentHtml: linkifyHtml(ok) } : { ...b, contentHtml: undefined };
  });
  return serializeBlocksRaw(withLinks);
}
function serializeBlocksRaw(blocks: ContentBlock[]): string {
  return JSON.stringify(blocks);
}

function stripImagePlaceholders(s: string): string {
  return (s || "").replace(/\[imagem-?\d*\]/gi, "").replace(/\n{3,}/g, "\n\n");
}

function deserializeBlocks(raw: string): ContentBlock[] {
  if (!raw) return [{ type: "text", content: "" }];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((b: any) => {
        if (b.type === "text") return { ...b, content: stripImagePlaceholders(b.content || "") };
        return b;
      });
    }
  } catch { /* legacy plain text */ }
  return [{ type: "text", content: stripImagePlaceholders(raw) }];
}

// ── Tabela Manual: helpers de cálculo ─────────────────
// Garante que a nota sempre termine com um bloco de texto (mesmo vazio), pra
// sempre existir um lugar clicável pra continuar escrevendo. Corrige notas
// antigas/importadas que terminam em Tabela Manual ou Checklist sem essa linha.
function ensureTrailingTextBlock(blocks: ContentBlock[]): ContentBlock[] {
  if (blocks.length === 0) return [{ type: "text", content: "" }];
  const last = blocks[blocks.length - 1];
  if (last.type !== "text") {
    return [...blocks, { type: "text", content: "" }];
  }
  return blocks;
}

function tableValorEhPorcentagem(valor: string): boolean {
  return valor.trim().endsWith("%");
}

function tableValorParaNumero(valor: string): number {
  const limpo = valor.trim().replace(/%/g, "").replace(/R\$/gi, "").trim();
  if (!limpo) return 0;

  // Caminho mais comum: um número simples com vírgula decimal (ex: "55,41" ou "-10")
  const numeroSimples = limpo.replace(",", ".");
  if (/^-?\d+(\.\d+)?$/.test(numeroSimples)) {
    const n = parseFloat(numeroSimples);
    return isNaN(n) ? 0 : n;
  }

  // Expressão com + - * / ( ) — ex: "5*3", "10/2", "55,41+0,01", "(10+5)/3"
  // "x" e "÷" também são aceitos como atalhos de multiplicar/dividir.
  const expressao = limpo
    .replace(/,/g, ".")
    .replace(/x/gi, "*")
    .replace(/÷/g, "/");
  // Validação de segurança: só permite números, espaços e os operadores +-*/(). — nada mais.
  if (!/^[0-9+\-*/().\s]+$/.test(expressao)) return 0;
  try {
    // eslint-disable-next-line no-new-func
    const resultado = Function(`"use strict"; return (${expressao});`)();
    return typeof resultado === "number" && isFinite(resultado) ? resultado : 0;
  } catch {
    return 0;
  }
}

function formatarMoedaBRL(valor: number): string {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Número simples (ex.: "100,49", "-5", "R$ 10"): é o único caso mostrado como dinheiro.
// Porcentagem (-10%) e expressões digitadas direto no campo continuam aparecendo como estão.
function valorEhNumeroSimples(valor: string): boolean {
  const limpo = valor.trim().replace(/R\$/gi, "").trim();
  return /^-?\d+([.,]\d+)?$/.test(limpo);
}

// Vírgula automática da calculadora: digitar 832 vira 8,32 (os centavos entram pela direita).
// Vale para valores no começo da conta ou depois de + − (; depois de × ÷ o número fica como digitado (ex.: × 3).
function aplicarVirgulaAutomatica(texto: string): string {
  const m = texto.match(/[\d.,]+$/);
  if (!m) return texto;
  const token = m[0];
  const antes = texto.slice(0, texto.length - token.length);
  const anterior = antes.trimEnd().slice(-1);
  if (anterior && !["+", "-", "−", "("].includes(anterior)) return texto;
  const digitos = token.replace(/\D/g, "").slice(0, 12);
  if (!digitos || /^0+$/.test(digitos)) return antes; // apagou até zerar: tira o número
  const cheio = digitos.replace(/^0+(?=\d)/, "").padStart(3, "0");
  return `${antes}${cheio.slice(0, -2)},${cheio.slice(-2)}`;
}

// Fora da edição do campo o valor aparece como R$ 100,49; ao tocar no campo volta o texto digitado.
function valorParaExibir(valor: string, editando: boolean): string {
  if (editando || !valor.trim() || tableValorEhPorcentagem(valor) || !valorEhNumeroSimples(valor)) return valor;
  return formatarMoedaBRL(tableValorParaNumero(valor));
}

/**
 * 1. Subtotal = soma dos itens marcados cujo valor NÃO é porcentagem.
 * 2. Cada item marcado com porcentagem aplica o percentual sobre esse subtotal.
 * 3. Total = subtotal + soma dos ajustes percentuais.
 */
function calcularTotalTabela(items: TableItem[]): number {
  const marcados = items.filter((i) => i.marcado);
  const subtotal = marcados
    .filter((i) => !tableValorEhPorcentagem(i.valor))
    .reduce((acc, i) => acc + tableValorParaNumero(i.valor), 0);
  const ajuste = marcados
    .filter((i) => tableValorEhPorcentagem(i.valor))
    .reduce((acc, i) => acc + (subtotal * tableValorParaNumero(i.valor)) / 100, 0);
  return subtotal + ajuste;
}

function tableItemsToPlainText(items: TableItem[]): string {
  if (!items.length) return "";
  const linhas = items.map((i) => {
    const marca = i.marcado ? "[X]" : "[ ]";
    return `${marca} ${i.nome}: ${i.valor}`;
  });
  linhas.push(`Total: ${formatarMoedaBRL(calcularTotalTabela(items))}`);
  return linhas.join("\n");
}

function blocksToPlainText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.content || "";
      if (b.type === "table" && b.tableItems) return tableItemsToPlainText(b.tableItems);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** true quando a nota tem algo além de texto vazio (texto, foto, checklist ou tabela). */
function blocksHaveBody(blocks: ContentBlock[]): boolean {
  return blocks.some(
    (b) =>
      (b.type === "text" && !!b.content?.trim()) ||
      b.type === "image" ||
      (b.type === "checklist" && (b.items?.length ?? 0) > 0) ||
      (b.type === "table" && (b.tableItems?.length ?? 0) > 0)
  );
}

function getTheme(color: string) {
  return COLOR_THEMES[color] || COLOR_THEMES["bg-yellow-100"];
}

// ── Props ──────────────────────────────────────────────
interface NoteEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingNote: Note | null;
  readOnly?: boolean;
  onSetReadOnly?: (readOnly: boolean) => void;
  initialSharedData?: { title: string; content: string } | null;
  onSave: (
    title: string,
    content: string,
    images: string[],
    color: string,
    fontFamily: string,
    fontSize: string,
    status: "rascunho" | "publicada",
  ) => void;
  onSchedule?: (title: string, content: string, date: string, time: string, sound: AlertSoundId) => void;
  onDelete?: (id: string) => void;
}

// ── ImageAnnotator: editor de desenho tipo Paint (caneta, seta, linha, ──
// ── retângulo, círculo, texto, borracha de objeto, cores, zoom/lupa) ──
type DrawTool = "pen" | "arrow" | "line" | "rect" | "circle" | "text" | "eraser" | "crop";

type CropRect = { x: number; y: number; w: number; h: number };

type DrawObject =
  | { type: "pen"; points: { x: number; y: number }[]; color: string; width: number }
  | { type: "arrow"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "rect"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "circle"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { type: "text"; x: number; y: number; text: string; color: string; size: number };

const DRAW_COLORS = ["#E53935", "#FB8C00", "#FDD835", "#2D9E7F", "#1E88E5", "#8E24AA", "#1A1A2E", "#FFFFFF"];

function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx, projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

function hitTestObject(obj: DrawObject, p: { x: number; y: number }): boolean {
  const pad = 14;
  if (obj.type === "pen") return obj.points.some((pt, i) => i > 0 && distToSegment(p, obj.points[i - 1], pt) < pad);
  if (obj.type === "line" || obj.type === "arrow") return distToSegment(p, { x: obj.x1, y: obj.y1 }, { x: obj.x2, y: obj.y2 }) < pad;
  if (obj.type === "rect") {
    const x1 = Math.min(obj.x1, obj.x2), x2 = Math.max(obj.x1, obj.x2);
    const y1 = Math.min(obj.y1, obj.y2), y2 = Math.max(obj.y1, obj.y2);
    return p.x >= x1 - pad && p.x <= x2 + pad && p.y >= y1 - pad && p.y <= y2 + pad &&
      (p.x < x1 + pad || p.x > x2 - pad || p.y < y1 + pad || p.y > y2 - pad);
  }
  if (obj.type === "circle") {
    const rx = Math.abs(obj.x2 - obj.x1) / 2, ry = Math.abs(obj.y2 - obj.y1) / 2;
    const cx = (obj.x1 + obj.x2) / 2, cy = (obj.y1 + obj.y2) / 2;
    if (rx === 0 || ry === 0) return false;
    const norm = ((p.x - cx) / rx) ** 2 + ((p.y - cy) / ry) ** 2;
    return norm > 0.75 && norm < 1.25;
  }
  if (obj.type === "text") return p.x >= obj.x - pad && p.x <= obj.x + obj.text.length * obj.size * 0.6 + pad && p.y >= obj.y - pad && p.y <= obj.y + obj.size + pad;
  return false;
}

function drawObjectOnCanvas(ctx: CanvasRenderingContext2D, obj: DrawObject) {
  ctx.strokeStyle = obj.color;
  ctx.fillStyle = obj.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (obj.type === "pen") {
    ctx.lineWidth = obj.width;
    if (obj.points.length < 2) {
      if (obj.points.length === 1) { ctx.beginPath(); ctx.arc(obj.points[0].x, obj.points[0].y, obj.width / 2, 0, Math.PI * 2); ctx.fill(); }
      return;
    }
    ctx.beginPath();
    ctx.moveTo(obj.points[0].x, obj.points[0].y);
    obj.points.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  } else if (obj.type === "line" || obj.type === "arrow") {
    ctx.lineWidth = obj.width;
    ctx.beginPath();
    ctx.moveTo(obj.x1, obj.y1);
    ctx.lineTo(obj.x2, obj.y2);
    ctx.stroke();
    if (obj.type === "arrow") {
      const angle = Math.atan2(obj.y2 - obj.y1, obj.x2 - obj.x1);
      const headLen = Math.max(14, obj.width * 3.5);
      ctx.beginPath();
      ctx.moveTo(obj.x2, obj.y2);
      ctx.lineTo(obj.x2 - headLen * Math.cos(angle - Math.PI / 6), obj.y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(obj.x2, obj.y2);
      ctx.lineTo(obj.x2 - headLen * Math.cos(angle + Math.PI / 6), obj.y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
  } else if (obj.type === "rect") {
    ctx.lineWidth = obj.width;
    ctx.strokeRect(Math.min(obj.x1, obj.x2), Math.min(obj.y1, obj.y2), Math.abs(obj.x2 - obj.x1), Math.abs(obj.y2 - obj.y1));
  } else if (obj.type === "circle") {
    ctx.lineWidth = obj.width;
    const rx = Math.abs(obj.x2 - obj.x1) / 2, ry = Math.abs(obj.y2 - obj.y1) / 2;
    const cx = (obj.x1 + obj.x2) / 2, cy = (obj.y1 + obj.y2) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (obj.type === "text") {
    ctx.font = `700 ${obj.size}px sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(obj.text, obj.x, obj.y);
  }
}

// Move um desenho junto com o corte (o corte muda a origem da foto)
function shiftDrawObject(obj: DrawObject, dx: number, dy: number): DrawObject {
  if (obj.type === "pen") return { ...obj, points: obj.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) };
  if (obj.type === "text") return { ...obj, x: obj.x + dx, y: obj.y + dy };
  return { ...obj, x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy };
}

// Converte uma imagem em texto (data URL) de volta em arquivo
function dataUrlToFile(dataUrl: string, name: string): File {
  const parts = dataUrl.split(",");
  const mime = parts[0].match(/:(.*?);/)?.[1] || "image/jpeg";
  const bin = atob(parts[1] || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

function ImageAnnotator({
  imageUrl, onSave, onCancel, initialTool, title, cancelLabel, saveLabel, saveQuality,
}: {
  imageUrl: string;
  onSave: (dataUrl: string) => void;
  onCancel: () => void;
  initialTool?: DrawTool;
  title?: string;
  cancelLabel?: string;
  saveLabel?: string;
  saveQuality?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<CanvasImageSource | null>(null);
  const drawingRef = useRef<{ active: boolean; current: DrawObject | null }>({ active: false, current: null });
  const [tool, setTool] = useState<DrawTool>(initialTool || "pen");
  const [color, setColor] = useState("#E53935");
  const [strokeWidth, setStrokeWidth] = useState(5);
  const [objects, setObjects] = useState<DrawObject[]>([]);
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ w: 300, h: 300 });
  const [ready, setReady] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  // Rastreia só a pinça de dois dedos (pra dar zoom) — mover a foto agora é
  // rolagem NATIVA de verdade (funciona com o dedo, com a roda do mouse, e
  // arrastando a barra de rolagem no computador), em vez de um sistema
  // próprio em JavaScript.
  const gestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    mode: "idle" | "draw" | "pinch";
    startDist: number;
    startZoom: number;
    lastMidX: number;
    lastMidY: number;
  }>({
    pointers: new Map(),
    mode: "idle",
    startDist: 0, startZoom: 1, lastMidX: 0, lastMidY: 0,
  });
  const [textPrompt, setTextPrompt] = useState<{ x: number; y: number } | null>(null);
  const [textInput, setTextInput] = useState("");

  // ── Corte: escolher a parte da foto que fica ──
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [cropHistory, setCropHistory] = useState<Array<{ img: CanvasImageSource; size: { w: number; h: number }; objects: DrawObject[] }>>([]);
  const [canvasBox, setCanvasBox] = useState({ left: 0, top: 0, w: 0, h: 0 });
  const cropDragRef = useRef<{ mode: string; startX: number; startY: number; rect: CropRect } | null>(null);

  // mede onde a foto está na tela, para o retângulo de corte ficar exatamente por cima dela
  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const measure = () => setCanvasBox({ left: c.offsetLeft, top: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight });
    measure();
    const t = setTimeout(measure, 220); // depois da animação do zoom
    window.addEventListener("resize", measure);
    return () => { clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [ready, zoom, canvasSize, tool]);

  // ao escolher "Cortar", começa com um retângulo um pouco menor que a foto
  useEffect(() => {
    if (tool !== "crop") { setCropRect(null); return; }
    setCropRect((r) => r ?? { x: canvasSize.w * 0.06, y: canvasSize.h * 0.06, w: canvasSize.w * 0.88, h: canvasSize.h * 0.88 });
  }, [tool, canvasSize.w, canvasSize.h, ready]);

  function startCropDrag(e: React.PointerEvent, mode: string) {
    e.stopPropagation();
    e.preventDefault();
    if (!cropRect) return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
    cropDragRef.current = { mode, startX: e.clientX, startY: e.clientY, rect: { ...cropRect } };
  }

  function moveCropDrag(e: React.PointerEvent) {
    const d = cropDragRef.current;
    if (!d || canvasBox.w === 0 || canvasBox.h === 0) return;
    e.stopPropagation();
    e.preventDefault();
    const W = canvasSize.w, H = canvasSize.h;
    const dx = (e.clientX - d.startX) * (W / canvasBox.w);
    const dy = (e.clientY - d.startY) * (H / canvasBox.h);
    const MIN = Math.max(30, Math.min(W, H) * 0.05);
    if (d.mode === "move") {
      const x = Math.min(Math.max(0, d.rect.x + dx), W - d.rect.w);
      const y = Math.min(Math.max(0, d.rect.y + dy), H - d.rect.h);
      setCropRect({ x, y, w: d.rect.w, h: d.rect.h });
      return;
    }
    let l = d.rect.x, t = d.rect.y, r = d.rect.x + d.rect.w, b = d.rect.y + d.rect.h;
    if (d.mode.includes("l")) l = Math.min(Math.max(0, l + dx), r - MIN);
    if (d.mode.includes("r")) r = Math.max(Math.min(W, r + dx), l + MIN);
    if (d.mode.includes("t")) t = Math.min(Math.max(0, t + dy), b - MIN);
    if (d.mode.includes("b")) b = Math.max(Math.min(H, b + dy), t + MIN);
    setCropRect({ x: l, y: t, w: r - l, h: b - t });
  }

  function endCropDrag() {
    cropDragRef.current = null;
  }

  function applyCrop() {
    const src = imgRef.current;
    if (!cropRect || !src) return;
    const x = Math.max(0, Math.round(cropRect.x));
    const y = Math.max(0, Math.round(cropRect.y));
    const w = Math.max(1, Math.min(canvasSize.w - x, Math.round(cropRect.w)));
    const h = Math.max(1, Math.min(canvasSize.h - y, Math.round(cropRect.h)));
    // foto inteira: nada para cortar
    if (x <= 1 && y <= 1 && w >= canvasSize.w - 2 && h >= canvasSize.h - 2) { setTool("pen"); return; }
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const ctx = off.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
    setCropHistory((hst) => [...hst, { img: src, size: { ...canvasSize }, objects }]);
    imgRef.current = off;
    setObjects((prev) => prev.map((o) => shiftDrawObject(o, -x, -y)));
    setCanvasSize({ w, h });
    setZoom(1);
    setTool("pen");
  }

  function undoCrop() {
    const last = cropHistory[cropHistory.length - 1];
    if (!last) return;
    imgRef.current = last.img;
    setCanvasSize(last.size);
    setObjects(last.objects);
    setCropHistory((hst) => hst.slice(0, -1));
  }

  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setCanvasSize({ w: img.naturalWidth || 300, h: img.naturalHeight || 300 });
      setReady(true);
    };
    img.onerror = () => {
      // Se a imagem vier de outro domínio sem permissão de CORS, tenta de novo sem
      // marcar como cross-origin (perde a capacidade de salvar depois, mas não trava).
      const fallback = new Image();
      fallback.onload = () => {
        imgRef.current = fallback;
        setCanvasSize({ w: fallback.naturalWidth || 300, h: fallback.naturalHeight || 300 });
        setReady(true);
      };
      fallback.onerror = () => setLoadError(true);
      fallback.src = imageUrl;
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    if (canvas.width !== canvasSize.w) canvas.width = canvasSize.w;
    if (canvas.height !== canvasSize.h) canvas.height = canvasSize.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const all = drawingRef.current.current ? [...objects, drawingRef.current.current] : objects;
    all.filter(Boolean).forEach((obj) => drawObjectOnCanvas(ctx, obj));
  }, [objects, canvasSize]);

  useEffect(() => { if (ready) redraw(); }, [ready, redraw]);

  function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function mid(a: { x: number; y: number }, b: { x: number; y: number }) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function zoomBy(delta: number) {
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, +(z + delta).toFixed(2))));
  }

  function getPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    if (tool === "crop") return; // no modo corte, quem mexe são as alças do retângulo
    const p = getPoint(e);

    if (tool === "text") { setTextPrompt(p); return; }

    if (tool === "eraser") {
      // Remove o objeto desenhado mais próximo do toque (apaga a forma inteira, não pixel a pixel)
      setObjects((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (hitTestObject(prev[i], p)) return prev.filter((_, idx) => idx !== i);
        }
        return prev;
      });
      return;
    }

    drawingRef.current.active = true;
    if (tool === "pen") drawingRef.current.current = { type: "pen", points: [p], color, width: strokeWidth };
    else if (tool === "arrow") drawingRef.current.current = { type: "arrow", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: strokeWidth };
    else if (tool === "line") drawingRef.current.current = { type: "line", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: strokeWidth };
    else if (tool === "rect") drawingRef.current.current = { type: "rect", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: strokeWidth };
    else if (tool === "circle") drawingRef.current.current = { type: "circle", x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, width: strokeWidth };
    redraw();
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current.active || !drawingRef.current.current) return;
    e.preventDefault();
    const p = getPoint(e);
    const cur = drawingRef.current.current;
    if (cur.type === "pen") cur.points.push(p);
    else { (cur as any).x2 = p.x; (cur as any).y2 = p.y; }
    redraw();
  }

  function handlePointerUp() {
    if (!drawingRef.current.active || !drawingRef.current.current) return;
    const finished = drawingRef.current.current;
    setObjects((prev) => [...prev, finished]);
    drawingRef.current.active = false;
    drawingRef.current.current = null;
  }

  // Distingue 1 dedo (desenha, do jeito que já sempre funcionou) de 2 dedos
  // (pinça: dá zoom com foco exato entre os dedos, e arrastando os dois
  // juntos move a foto pra desenhar em qualquer parte dela, mesmo ampliada).
  function handleWrapperPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g.pointers.size === 2) {
      // Um segundo dedo tocou no meio de um traço — descarta o traço em
      // andamento (foi sem querer) e passa a tratar como pinça.
      if (drawingRef.current.active) {
        drawingRef.current.active = false;
        drawingRef.current.current = null;
        redraw();
      }
      const pts = Array.from(g.pointers.values());
      g.mode = "pinch";
      g.startDist = dist(pts[0], pts[1]) || 1;
      g.startZoom = zoom;
      const m0 = mid(pts[0], pts[1]);
      g.lastMidX = m0.x;
      g.lastMidY = m0.y;
      return;
    }

    if (g.pointers.size === 1) {
      g.mode = "draw";
      handlePointerDown(e as unknown as React.PointerEvent<HTMLCanvasElement>);
    }
  }

  function handleWrapperPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g.mode === "pinch" && g.pointers.size === 2) {
      const pts = Array.from(g.pointers.values());
      const newDist = dist(pts[0], pts[1]);
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, g.startZoom * (newDist / g.startDist)));
      const m = mid(pts[0], pts[1]);
      // Move a rolagem de verdade (scrollLeft/scrollTop) seguindo o quanto
      // o meio-ponto dos 2 dedos andou — isso é o que faz mover a foto pra
      // qualquer direção funcionar, usando a MESMA rolagem que também
      // funciona com barra de rolagem/roda do mouse no computador.
      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.scrollLeft -= m.x - g.lastMidX;
        wrapper.scrollTop -= m.y - g.lastMidY;
      }
      g.lastMidX = m.x;
      g.lastMidY = m.y;
      setZoom(newZoom);
      return;
    }

    if (g.mode === "draw" && g.pointers.size === 1) {
      handlePointerMove(e as unknown as React.PointerEvent<HTMLCanvasElement>);
    }
  }

  function handleWrapperPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const g = gestureRef.current;
    g.pointers.delete(e.pointerId);

    if (g.mode === "pinch") {
      if (g.pointers.size === 0) {
        g.mode = "idle";
      }
      // Levanta 1 dedo e ainda sobra outro: não volta a desenhar sozinho
      // com ele, pra não deixar um traço sem querer logo após a pinça.
      return;
    }

    if (g.pointers.size === 0) {
      handlePointerUp();
      g.mode = "idle";
    }
  }

  function confirmText() {
    if (textPrompt && textInput.trim()) {
      setObjects((prev) => [...prev, { type: "text", x: textPrompt.x, y: textPrompt.y, text: textInput.trim(), color, size: 18 + strokeWidth * 3 }]);
    }
    setTextPrompt(null);
    setTextInput("");
  }

  const [saveError, setSaveError] = useState(false);

  function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL("image/jpeg", saveQuality ?? 0.88);
      onSave(dataUrl);
    } catch (err) {
      setSaveError(true);
    }
  }

  const TOOLS: { id: DrawTool; icon: JSX.Element; label: string }[] = [
    { id: "crop", icon: <Crop size={18} />, label: "Cortar" },
    { id: "pen", icon: <Paintbrush size={18} />, label: "Caneta" },
    { id: "arrow", icon: <ArrowUpRight size={18} />, label: "Seta" },
    { id: "line", icon: <Minus size={18} />, label: "Linha" },
    { id: "rect", icon: <Square size={18} />, label: "Retângulo" },
    { id: "circle", icon: <Circle size={18} />, label: "Círculo" },
    { id: "text", icon: <Type size={18} />, label: "Texto" },
    { id: "eraser", icon: <Eraser size={18} />, label: "Apagar" },
  ];

  return (
    <div className="absolute inset-0 z-[85] flex flex-col bg-black" style={{ touchAction: "none" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 12px", paddingTop: "calc(12px + env(safe-area-inset-top))", flexShrink: 0 }}>
        <button onClick={onCancel} style={{ color: "#FFF", fontSize: 14, fontWeight: 600, background: "none", border: "none", padding: "10px 12px", margin: "-10px -4px" }}>{cancelLabel || "Cancelar"}</button>
        <span style={{ color: "#FFF", fontWeight: 700, fontSize: 14 }}>{title || "✏️ Editar imagem"}</span>
        <button onClick={handleSave} style={{ color: "#2D9E7F", fontSize: 14, fontWeight: 700, background: "none", border: "none", padding: "10px 12px", margin: "-10px -4px" }}>{saveLabel || "Salvar"}</button>
      </div>

      {/* Canvas area — rolagem NATIVA de verdade (funciona com a barra de
          rolagem e a roda do mouse no computador, e com o dedo no celular),
          em vez de um sistema de posição próprio em JavaScript. */}
      <div
        ref={wrapperRef}
        style={{
          flex: 1,
          overflow: "auto",
          position: "relative",
          display: "flex",
          alignItems: zoom <= 1 ? "center" : "flex-start",
          justifyContent: zoom <= 1 ? "center" : "flex-start",
          padding: 8,
        }}
        onPointerDown={handleWrapperPointerDown}
        onPointerMove={handleWrapperPointerMove}
        onPointerUp={handleWrapperPointerUp}
        onPointerCancel={handleWrapperPointerUp}
      >
        {loadError ? (
          <div style={{ textAlign: "center", padding: 20, color: "#FFF" }}>
            <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>😕 Não consegui carregar essa imagem pra editar.</p>
            <p style={{ fontSize: 12, color: "#AAA" }}>Toque em "Cancelar" e tente novamente.</p>
          </div>
        ) : ready ? (
          <>
          <canvas
            ref={canvasRef}
            style={{
              width: `${canvasSize.w * zoom}px`,
              maxWidth: zoom <= 1 ? "100%" : "none",
              height: "auto",
              touchAction: "none",
              background: "#fff",
              borderRadius: 4,
              margin: zoom <= 1 ? "auto" : 0,
              transition: "width 0.15s ease",
            }}
          />
          {tool === "crop" && cropRect && canvasBox.w > 0 && (
            <>
              {/* parte de fora do corte escurecida (não recebe toque) */}
              <div style={{ position: "absolute", left: canvasBox.left, top: canvasBox.top, width: canvasBox.w, height: canvasBox.h, overflow: "hidden", pointerEvents: "none" }}>
                <div
                  style={{
                    position: "absolute",
                    left: `${(cropRect.x / canvasSize.w) * 100}%`, top: `${(cropRect.y / canvasSize.h) * 100}%`,
                    width: `${(cropRect.w / canvasSize.w) * 100}%`, height: `${(cropRect.h / canvasSize.h) * 100}%`,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)",
                  }}
                />
              </div>
              {/* retângulo que se arrasta + 8 alças para esticar */}
              <div style={{ position: "absolute", left: canvasBox.left, top: canvasBox.top, width: canvasBox.w, height: canvasBox.h, pointerEvents: "none" }}>
                <div
                  onPointerDown={(e) => startCropDrag(e, "move")}
                  onPointerMove={moveCropDrag}
                  onPointerUp={endCropDrag}
                  onPointerCancel={endCropDrag}
                  style={{
                    position: "absolute",
                    left: `${(cropRect.x / canvasSize.w) * 100}%`, top: `${(cropRect.y / canvasSize.h) * 100}%`,
                    width: `${(cropRect.w / canvasSize.w) * 100}%`, height: `${(cropRect.h / canvasSize.h) * 100}%`,
                    border: "2px solid #FFF", boxSizing: "border-box", pointerEvents: "auto", touchAction: "none", cursor: "move",
                  }}
                >
                  {[
                    { m: "tl", l: "0%", t: "0%" }, { m: "t", l: "50%", t: "0%" }, { m: "tr", l: "100%", t: "0%" },
                    { m: "l", l: "0%", t: "50%" }, { m: "r", l: "100%", t: "50%" },
                    { m: "bl", l: "0%", t: "100%" }, { m: "b", l: "50%", t: "100%" }, { m: "br", l: "100%", t: "100%" },
                  ].map((hd) => (
                    <div
                      key={hd.m}
                      onPointerDown={(e) => startCropDrag(e, hd.m)}
                      onPointerMove={moveCropDrag}
                      onPointerUp={endCropDrag}
                      onPointerCancel={endCropDrag}
                      style={{
                        position: "absolute", left: hd.l, top: hd.t, width: 44, height: 44, marginLeft: -22, marginTop: -22,
                        display: "flex", alignItems: "center", justifyContent: "center", touchAction: "none", pointerEvents: "auto",
                      }}
                    >
                      <div style={{ width: 16, height: 16, borderRadius: 4, background: "#2D9E7F", border: "2px solid #FFF" }} />
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          </>
        ) : (
          <Loader2 size={32} className="animate-spin text-white" />
        )}
      </div>
      {zoom > 1.01 && (
        <p style={{ textAlign: "center", color: "rgba(255,255,255,0.55)", fontSize: 11, margin: "2px 0 0" }}>
          Use 2 dedos pra mover a foto e ajustar o zoom
        </p>
      )}

      {/* Aviso se não conseguir salvar (bloqueio de segurança do navegador) */}
      {saveError && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 96, padding: 20 }} onClick={() => setSaveError(false)}>
          <div style={{ background: "#FFF", borderRadius: 14, padding: 18, maxWidth: 300, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <p style={{ fontSize: 14, fontWeight: 700, color: "#1A1A2E", margin: "0 0 8px" }}>😕 Não consegui salvar</p>
            <p style={{ fontSize: 12, color: "#9E9E9E", margin: "0 0 14px" }}>O navegador bloqueou o salvamento por segurança (a imagem vem de outro endereço). Tente tirar a foto de novo, ou avise o suporte.</p>
            <button onClick={() => setSaveError(false)} style={{ width: "100%", padding: "8px 0", borderRadius: 8, border: "none", background: "#2D9E7F", color: "#FFF", fontWeight: 600, fontSize: 13 }}>Entendi</button>
          </div>
        </div>
      )}

      {/* Text input prompt */}
      {textPrompt && (
        <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 95, padding: 20 }} onClick={() => { setTextPrompt(null); setTextInput(""); }}>
          <div style={{ background: "#FFF", borderRadius: 14, padding: 16, width: "100%", maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
            <p style={{ fontSize: 13, fontWeight: 700, color: "#1A1A2E", margin: "0 0 8px" }}>Digite o texto</p>
            <input
              autoFocus
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmText(); }}
              placeholder="Escreva aqui..."
              style={{ width: "100%", padding: "8px 10px", border: "1px solid #E0E0E0", borderRadius: 8, fontSize: 14, outline: "none" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button onClick={() => { setTextPrompt(null); setTextInput(""); }} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", background: "#F0F0F0", color: "#1A1A2E", fontWeight: 600, fontSize: 13 }}>Cancelar</button>
              <button onClick={confirmText} style={{ flex: 1, padding: "8px 0", borderRadius: 8, border: "none", background: "#2D9E7F", color: "#FFF", fontWeight: 600, fontSize: 13 }}>Adicionar</button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom toolbar */}
      <div style={{ padding: "10px 10px calc(10px + env(safe-area-inset-bottom))", background: "#161616", display: "flex", flexDirection: "column", gap: 8, flexShrink: 0 }}>
        {/* Corte: confirmar, foto inteira ou sair do corte */}
        {tool === "crop" && (
          <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ width: "100%", textAlign: "center", color: "rgba(255,255,255,0.7)", fontSize: 11 }}>
              Arraste os cantos e as bordas para escolher a parte que fica
            </span>
            <button onClick={applyCrop} style={{ padding: "8px 16px", borderRadius: 8, background: "#2D9E7F", color: "#FFF", border: "none", fontWeight: 700, fontSize: 13 }}>
              ✂️ Cortar
            </button>
            <button
              onClick={() => setCropRect({ x: 0, y: 0, w: canvasSize.w, h: canvasSize.h })}
              style={{ padding: "8px 12px", borderRadius: 8, background: "#2E2E2E", color: "#FFF", border: "none", fontSize: 12, fontWeight: 600 }}
            >
              Foto inteira
            </button>
            <button onClick={() => setTool("pen")} style={{ padding: "8px 12px", borderRadius: 8, background: "#2E2E2E", color: "#FFF", border: "none", fontSize: 12, fontWeight: 600 }}>
              Sair do corte
            </button>
          </div>
        )}

        {/* Tools — quebra linha em telas estreitas, em vez de esconder cortado */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTool(t.id)}
              title={t.label}
              style={{ padding: 8, borderRadius: 8, background: tool === t.id ? "#2D9E7F" : "#2E2E2E", color: "#FFF", flexShrink: 0, border: "none" }}
            >
              {t.icon}
            </button>
          ))}
          <div style={{ width: 1, background: "#3A3A3A", margin: "0 2px" }} />
          <button onClick={() => setObjects((prev) => prev.slice(0, -1))} title="Desfazer último" style={{ padding: 8, borderRadius: 8, background: "#2E2E2E", color: "#FFF", flexShrink: 0, border: "none" }}>
            <Undo2 size={18} />
          </button>
          <button onClick={() => setObjects([])} title="Limpar tudo" style={{ padding: 8, borderRadius: 8, background: "#2E2E2E", color: "#FFF", flexShrink: 0, border: "none", fontSize: 11, fontWeight: 700 }}>
            Limpar
          </button>
          {cropHistory.length > 0 && (
            <button onClick={undoCrop} title="Desfazer o último corte" style={{ padding: 8, borderRadius: 8, background: "#2E2E2E", color: "#FFF", flexShrink: 0, border: "none", fontSize: 11, fontWeight: 600 }}>
              ↩ Corte
            </button>
          )}
        </div>

        {/* Colors + width — também quebra linha em vez de esconder cor cortada */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {DRAW_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{ width: 24, height: 24, borderRadius: "50%", background: c, border: color === c ? "2px solid #2D9E7F" : "2px solid #444", flexShrink: 0 }}
            />
          ))}
          <label style={{ position: "relative", width: 24, height: 24, borderRadius: "50%", overflow: "hidden", border: "2px solid #444", flexShrink: 0, display: "flex" }}>
            <Palette size={14} style={{ margin: "auto", color: "#FFF" }} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} />
          </label>
          <input
            type="range" min={2} max={20} value={strokeWidth}
            onChange={(e) => setStrokeWidth(Number(e.target.value))}
            style={{ flex: 1, minWidth: 60, marginLeft: 4 }}
          />
        </div>

        {/* Zoom (lupa) — linha própria, sempre visível por inteiro */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
          <button onClick={() => zoomBy(-0.25)} title="Diminuir zoom (lupa)" style={{ padding: "6px 10px", borderRadius: 8, background: "#2E2E2E", color: "#FFF", border: "none", flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
            <ZoomOut size={16} />
          </button>
          <span style={{ color: "#FFF", fontSize: 12, minWidth: 40, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => zoomBy(0.25)} title="Aumentar zoom (lupa)" style={{ padding: "6px 10px", borderRadius: 8, background: "#2E2E2E", color: "#FFF", border: "none", flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>
            <ZoomIn size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Rede de segurança: se o editor de desenho der algum erro inesperado, ──
// ── mostra um aviso só ali dentro, em vez de derrubar o app inteiro (tela branca). ──
class AnnotatorErrorBoundary extends Component<
  { children: ReactNode; onCancel: () => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onCancel: () => void }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: unknown) {
    console.error("Erro no editor de desenho:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="absolute inset-0 z-[85] flex flex-col items-center justify-center bg-black gap-4 px-8">
          <p style={{ color: "#FFF", fontSize: 14, fontWeight: 600, textAlign: "center" }}>😕 Não consegui abrir o editor de desenho pra essa imagem.</p>
          <button onClick={this.props.onCancel} style={{ padding: "10px 24px", borderRadius: 10, border: "none", background: "#2D9E7F", color: "#FFF", fontWeight: 600, fontSize: 13 }}>
            Voltar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Component ──────────────────────────────────────────
export function NoteEditor({ open, onOpenChange, editingNote, readOnly = false, onSetReadOnly, initialSharedData, onSave, onSchedule, onDelete }: NoteEditorProps) {
  const [title, setTitle] = useState("");
  const [blocks, setBlocks] = useState<ContentBlock[]>([{ type: "text", content: "" }]);
  const [editingImageIdx, setEditingImageIdx] = useState<number | null>(null);
  // Corte de fotos: ferramenta com que o editor abre, e o "cortar ao adicionar" (uma foto de cada vez, na fila)
  const [annotatorStartTool, setAnnotatorStartTool] = useState<DrawTool | null>(null);
  const [cropOnAdd, setCropOnAdd] = useState<boolean>(() => {
    try { return localStorage.getItem("nb_crop_on_add") === "1"; } catch { return false; }
  });
  const [addCrop, setAddCrop] = useState<{ dataUrl: string; index: number; total: number } | null>(null);
  const addCropQueueRef = useRef<{ files: File[]; i: number; results: File[] } | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<{ type: "table" | "checklist"; blockIdx: number; itemId: string; label: string } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [pendingDeleteImageIdx, setPendingDeleteImageIdx] = useState<number | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [viewZoom, setViewZoom] = useState(1);
  const [viewTx, setViewTx] = useState(0);
  const [viewTy, setViewTy] = useState(0);
  const [viewRotation, setViewRotation] = useState(0);
  const [viewIndex, setViewIndex] = useState(0);
  const [viewDragging, setViewDragging] = useState(false);
  const [viewCloseOpacity, setViewCloseOpacity] = useState(1);
  // Visualizador de foto: true quando a tela do aparelho está deitada (horizontal).
  const [viewerLandscape, setViewerLandscape] = useState(false);
  // Botões do visualizador: aparecem ao abrir, somem sozinhos e voltam com um toque na foto.
  const [viewerUiVisible, setViewerUiVisible] = useState(true);
  const viewerTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const viewerImgRef = useRef<HTMLImageElement>(null);
  const baseImgSizeRef = useRef({ w: 0, h: 0 });
  const VIEW_MIN_ZOOM = 1;
  const VIEW_MAX_ZOOM = 5;
  const VIEW_DOUBLE_TAP_ZOOM = 2.5;
  const viewGestureRef = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    mode: "idle" | "pan" | "pinch" | "drag";
    dragAxis: "h" | "v" | null;
    startX: number; startY: number;
    startTx: number; startTy: number;
    startScale: number;
    startDist: number;
    startMidX: number; startMidY: number;
    centerX: number; centerY: number;
    moved: boolean;
    lastTapTime: number;
    lastTapX: number; lastTapY: number;
  }>({
    pointers: new Map(),
    mode: "idle",
    dragAxis: null,
    startX: 0, startY: 0, startTx: 0, startTy: 0,
    startScale: 1, startDist: 0, startMidX: 0, startMidY: 0,
    centerX: 0, centerY: 0, moved: false,
    lastTapTime: 0, lastTapX: 0, lastTapY: 0,
  });

  const noteImages = useMemo(
    () => blocks.filter((b) => b.type === "image" && b.url).map((b) => b.url as string),
    [blocks]
  );

  useEffect(() => {
    if (viewingImage) {
      const idx = noteImages.indexOf(viewingImage);
      if (idx >= 0) setViewIndex(idx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingImage]);

  const distBetween = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const midBetween = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const clampViewPan = (scale: number, tx: number, ty: number) => {
    const cRect = viewerContainerRef.current?.getBoundingClientRect();
    if (!cRect) return { x: tx, y: ty };
    const rotated90 = viewRotation === 90 || viewRotation === 270;
    const baseW = rotated90 ? baseImgSizeRef.current.h : baseImgSizeRef.current.w;
    const baseH = rotated90 ? baseImgSizeRef.current.w : baseImgSizeRef.current.h;
    const scaledW = baseW * scale;
    const scaledH = baseH * scale;
    const maxX = Math.max(0, (scaledW - cRect.width) / 2);
    const maxY = Math.max(0, (scaledH - cRect.height) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, tx)), y: Math.max(-maxY, Math.min(maxY, ty)) };
  };

  const handleViewerImgLoad = () => {
    if (viewerImgRef.current) {
      const r = viewerImgRef.current.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) baseImgSizeRef.current = { w: r.width, h: r.height };
    }
  };

  const zoomBy = (delta: number) => {
    const newScale = Math.max(VIEW_MIN_ZOOM, Math.min(VIEW_MAX_ZOOM, +(viewZoom + delta).toFixed(2)));
    const p0x = viewZoom > 0 ? -viewTx / viewZoom : 0;
    const p0y = viewZoom > 0 ? -viewTy / viewZoom : 0;
    const clamped = clampViewPan(newScale, -newScale * p0x, -newScale * p0y);
    setViewZoom(newScale);
    setViewTx(clamped.x);
    setViewTy(clamped.y);
  };

  // Preencher a tela: dá zoom até a foto cobrir a tela toda (sem faixas nas laterais ou em cima/embaixo),
  // cortando o que sobrar nas bordas. Tocar de novo volta ao ajuste inteiro.
  const fillViewerScreen = () => {
    if (viewZoom > 1.01) {
      setViewZoom(1);
      setViewTx(0);
      setViewTy(0);
      return;
    }
    const c = viewerContainerRef.current?.getBoundingClientRect();
    const im = viewerImgRef.current;
    if (!c || !im) return;
    const rotated90 = viewRotation === 90 || viewRotation === 270;
    const w0 = im.offsetWidth || baseImgSizeRef.current.w;
    const h0 = im.offsetHeight || baseImgSizeRef.current.h;
    if (!w0 || !h0) return;
    baseImgSizeRef.current = { w: w0, h: h0 };
    const bw = rotated90 ? h0 : w0;
    const bh = rotated90 ? w0 : h0;
    const s = Math.min(VIEW_MAX_ZOOM, Math.max(c.width / bw, c.height / bh));
    if (s <= 1.01) return;
    setViewZoom(s);
    setViewTx(0);
    setViewTy(0);
  };

  const goToImage = (images: string[], newIndex: number) => {
    if (images.length === 0) return;
    const clampedIdx = Math.max(0, Math.min(images.length - 1, newIndex));
    setViewIndex(clampedIdx);
    setViewingImage(images[clampedIdx]);
    setViewZoom(1);
    setViewTx(0);
    setViewTy(0);
    setViewRotation(0);
  };

  const handleViewerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = viewGestureRef.current;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    g.moved = false;
    const rect = e.currentTarget.getBoundingClientRect();
    g.centerX = rect.left + rect.width / 2;
    g.centerY = rect.top + rect.height / 2;

    if (g.pointers.size === 1) {
      g.mode = viewZoom > 1.01 ? "pan" : "drag";
      g.dragAxis = null;
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.startTx = viewTx;
      g.startTy = viewTy;
    } else if (g.pointers.size === 2) {
      const pts = Array.from(g.pointers.values());
      g.mode = "pinch";
      g.startDist = distBetween(pts[0], pts[1]) || 1;
      g.startScale = viewZoom;
      const m = midBetween(pts[0], pts[1]);
      g.startMidX = m.x;
      g.startMidY = m.y;
      g.startTx = viewTx;
      g.startTy = viewTy;
    }
    setViewDragging(true);
  };

  const handleViewerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = viewGestureRef.current;
    if (!g.pointers.has(e.pointerId)) return;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (g.mode === "pinch" && g.pointers.size === 2) {
      const pts = Array.from(g.pointers.values());
      const newDist = distBetween(pts[0], pts[1]);
      const m = midBetween(pts[0], pts[1]);
      const ratio = newDist / g.startDist;
      const newScale = Math.max(VIEW_MIN_ZOOM, Math.min(VIEW_MAX_ZOOM, g.startScale * ratio));
      const p0x = (g.startMidX - g.centerX - g.startTx) / g.startScale;
      const p0y = (g.startMidY - g.centerY - g.startTy) / g.startScale;
      const newTx = (m.x - g.centerX) - newScale * p0x;
      const newTy = (m.y - g.centerY) - newScale * p0y;
      const clamped = clampViewPan(newScale, newTx, newTy);
      setViewZoom(newScale);
      setViewTx(clamped.x);
      setViewTy(clamped.y);
      g.moved = true;
    } else if (g.mode === "pan") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) g.moved = true;
      const clamped = clampViewPan(viewZoom, g.startTx + dx, g.startTy + dy);
      setViewTx(clamped.x);
      setViewTy(clamped.y);
    } else if (g.mode === "drag") {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      if (!g.moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
        g.moved = true;
        g.dragAxis = Math.abs(dy) > Math.abs(dx) ? "v" : "h";
      }
      if (g.moved) {
        if (g.dragAxis === "v") {
          const clampedDy = Math.max(0, dy);
          setViewTy(clampedDy);
          setViewCloseOpacity(Math.max(0.25, 1 - clampedDy / 300));
        } else if (g.dragAxis === "h") {
          setViewTx(dx);
        }
      }
    }
  };

  const finishViewerDrag = (e: React.PointerEvent<HTMLDivElement>, images: string[]) => {
    const g = viewGestureRef.current;
    setViewDragging(false);
    if (g.mode === "drag" && g.moved) {
      if (g.dragAxis === "v") {
        if (viewTy > 110) {
          setViewingImage(null);
        } else {
          setViewTy(0);
          setViewCloseOpacity(1);
        }
      } else if (g.dragAxis === "h") {
        if (viewTx < -70 && viewIndex < images.length - 1) {
          goToImage(images, viewIndex + 1);
        } else if (viewTx > 70 && viewIndex > 0) {
          goToImage(images, viewIndex - 1);
        } else {
          setViewTx(0);
        }
      }
    } else if ((g.mode === "pan" || g.mode === "drag") && !g.moved) {
      const now = Date.now();
      const dtx = e.clientX - g.lastTapX;
      const dty = e.clientY - g.lastTapY;
      const isDouble = now - g.lastTapTime < 320 && Math.hypot(dtx, dty) < 40;
      if (isDouble) {
        if (viewerTapTimerRef.current) {
          clearTimeout(viewerTapTimerRef.current);
          viewerTapTimerRef.current = null;
        }
        if (viewZoom > 1.01) {
          setViewZoom(1);
          setViewTx(0);
          setViewTy(0);
        } else {
          const rect = viewerContainerRef.current?.getBoundingClientRect();
          if (rect) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const px = e.clientX - cx;
            const py = e.clientY - cy;
            const clamped = clampViewPan(VIEW_DOUBLE_TAP_ZOOM, -px * (VIEW_DOUBLE_TAP_ZOOM - 1), -py * (VIEW_DOUBLE_TAP_ZOOM - 1));
            setViewZoom(VIEW_DOUBLE_TAP_ZOOM);
            setViewTx(clamped.x);
            setViewTy(clamped.y);
          }
        }
        g.lastTapTime = 0;
      } else {
        g.lastTapTime = now;
        g.lastTapX = e.clientX;
        g.lastTapY = e.clientY;
        // toque simples: mostra/esconde os botões (espera um instante para não
        // confundir com o primeiro toque de um toque duplo)
        if (viewerTapTimerRef.current) clearTimeout(viewerTapTimerRef.current);
        viewerTapTimerRef.current = setTimeout(() => {
          viewerTapTimerRef.current = null;
          if (viewerHideTimerRef.current) {
            clearTimeout(viewerHideTimerRef.current);
            viewerHideTimerRef.current = null;
          }
          setViewerUiVisible((v) => !v);
        }, 330);
      }
    }
    g.mode = "idle";
    g.dragAxis = null;
  };

  const handleViewerPointerUp = (e: React.PointerEvent<HTMLDivElement>, images: string[]) => {
    const g = viewGestureRef.current;
    g.pointers.delete(e.pointerId);
    if (g.pointers.size === 1) {
      const remaining = Array.from(g.pointers.values())[0];
      g.mode = viewZoom > 1.01 ? "pan" : "drag";
      g.dragAxis = null;
      g.startX = remaining.x;
      g.startY = remaining.y;
      g.startTx = viewTx;
      g.startTy = viewTy;
      return;
    }
    if (g.pointers.size > 0) return;
    finishViewerDrag(e, images);
  };

  const handleViewerWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const delta = e.deltaY < 0 ? 0.2 : -0.2;
    const newScale = Math.max(VIEW_MIN_ZOOM, Math.min(VIEW_MAX_ZOOM, +(viewZoom + delta).toFixed(2)));
    const px = e.clientX - cx;
    const py = e.clientY - cy;
    const p0x = (px - viewTx) / viewZoom;
    const p0y = (py - viewTy) / viewZoom;
    const newTx = px - newScale * p0x;
    const newTy = py - newScale * p0y;
    const clamped = clampViewPan(newScale, newTx, newTy);
    setViewZoom(newScale);
    setViewTx(clamped.x);
    setViewTy(clamped.y);
  };

  const handleViewerRotate = () => {
    setViewRotation((r) => (r + 90) % 360);
    setViewZoom(1);
    setViewTx(0);
    setViewTy(0);
  };

  const handleViewerShareOrDownload = async () => {
    if (!viewingImage) return;
    const result = await shareOrSaveImage(viewingImage, "foto-nota.jpg");
    if (result === "saved") {
      toast({ title: "✅ Foto baixada!" });
    } else if (result === "failed") {
      toast({ title: "Não foi possível compartilhar essa foto", description: "Tente novamente.", variant: "destructive" });
    }
  };
  // Visualizador de foto: acompanha a tela virada (horizontal/vertical). Ao virar,
  // volta ao ajuste inteiro e mede de novo o tamanho da foto, para o arrastar/zoom
  // continuar certo.
  useEffect(() => {
    if (!viewingImage) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const im = viewerImgRef.current;
        if (im && im.offsetWidth > 0 && im.offsetHeight > 0) {
          baseImgSizeRef.current = { w: im.offsetWidth, h: im.offsetHeight };
        }
      }, 250);
    };
    const onResize = () => {
      setViewerLandscape(window.innerWidth > window.innerHeight);
      setViewZoom(1);
      setViewTx(0);
      setViewTy(0);
      measure();
    };
    setViewerLandscape(window.innerWidth > window.innerHeight);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [viewingImage]);

  // Ao abrir a foto (ou trocar de foto) os botões aparecem e somem sozinhos depois de
  // 2,5 segundos, deixando só a foto na tela.
  useEffect(() => {
    if (!viewingImage) return;
    setViewerUiVisible(true);
    if (viewerHideTimerRef.current) clearTimeout(viewerHideTimerRef.current);
    viewerHideTimerRef.current = setTimeout(() => {
      viewerHideTimerRef.current = null;
      setViewerUiVisible(false);
    }, 2500);
    return () => {
      if (viewerHideTimerRef.current) { clearTimeout(viewerHideTimerRef.current); viewerHideTimerRef.current = null; }
      if (viewerTapTimerRef.current) { clearTimeout(viewerTapTimerRef.current); viewerTapTimerRef.current = null; }
    };
  }, [viewingImage]);

  // Visualizador de foto no computador: Esc fecha só a foto; setas trocam de foto.
  useEffect(() => {
    if (!viewingImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setViewingImage(null);
      } else if (e.key === "ArrowRight" && noteImages.length > 1) {
        e.stopPropagation();
        goToImage(noteImages, viewIndex + 1);
      } else if (e.key === "ArrowLeft" && noteImages.length > 1) {
        e.stopPropagation();
        goToImage(noteImages, viewIndex - 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingImage, viewIndex, noteImages]);

  const [activeBlockIdx, setActiveBlockIdx] = useState<number | null>(null);
  // Contorno em volta do trecho selecionado: um retângulo por linha, desenhado por cima do texto.
  const selHostRef = useRef<HTMLDivElement | null>(null);
  const [selRects, setSelRects] = useState<Array<{ l: number; t: number; w: number; h: number }>>([]);
  const selRectsKeyRef = useRef("");
  const [selectedColor, setSelectedColor] = useState(NOTE_COLORS[0].value);
  // Última cor clara usada: o botão de modo escuro volta para ela (e nunca fica preso no escuro)
  const lastLightColorRef = useRef<string>(NOTE_COLORS[0].value);
  useEffect(() => {
    if (selectedColor !== "bg-gray-800") lastLightColorRef.current = selectedColor;
  }, [selectedColor]);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showOcrModal, setShowOcrModal] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [showQrScanner, setShowQrScanner] = useState(false);
  const [qrLoading, setQrLoading] = useState(false);
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleSound, setScheduleSound] = useState<AlertSoundId | null>(null);
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showFab, setShowFab] = useState(false);
  // Botão "Reduzir fotos" (menu ⋮): trabalhando agora? e em qual tamanho as fotos chegaram no mínimo.
  const [reduzindoFotos, setReduzindoFotos] = useState(false);
  const [fotosNoMinimoSig, setFotosNoMinimoSig] = useState("");
  // Menu "•••" que esconde a barra de ferramentas (cor, copiar, tema, tamanho de
  // fonte, formatação de texto etc.), deixando só uma linha limpa pra digitar.
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Fechou a nota no meio do "cortar ao adicionar": descarta a fila
  useEffect(() => {
    if (!open) { addCropQueueRef.current = null; setAddCrop(null); }
  }, [open]);
  // Painel de formatação do texto (botão "Aa" na barra de baixo): começa sempre fechado.
  const [showFormatBar, setShowFormatBar] = useState(false);
  useEffect(() => {
    if (!open || readOnly) setShowFormatBar(false);
  }, [open, readOnly]);
  const [editorFontSize, setEditorFontSize] = useState<number>(() => {
    const stored = parseInt(localStorage.getItem("editor_font_size") || "", 10);
    return [14, 16, 20, 24, 30].includes(stored) ? stored : 16;
  });
  const changeEditorFontSize = (size: number) => {
    setEditorFontSize(size);
    localStorage.setItem("editor_font_size", String(size));
  };

  // Snapshot of content when entering edit mode (for cancel)
  const snapshotRef = useRef<{ title: string; blocks: ContentBlock[]; color: string } | null>(null);

  // Undo/redo — cada ponto do histórico guarda título + corpo juntos, então
  // o Desfazer também volta o campo de título, não só o texto da nota.
  const [history, setHistory] = useState<{ title: string; blocks: ContentBlock[] }[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const titleRef = useRef("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const ocrFileRef = useRef<HTMLInputElement>(null);
  const ocrCameraRef = useRef<HTMLInputElement>(null);
  const focusedBlockRef = useRef<number>(0);
  const activeFieldRef = useRef<"title" | "content">("content");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const richTextRefs = useRef<Record<number, HTMLDivElement | null>>({});
  // Rastreia se o teclado do Android (Gboard e outros) está no meio de
  // "compor" uma palavra (antes de confirmar) — nesse meio tempo, nunca se
  // deve reescrever o innerHTML do campo, senão o texto pode aparecer
  // duplicado (bug conhecido de contentEditable + teclados Android).
  const isComposingRef = useRef<Record<number, boolean>>({});
  // Rastreamento próprio de foco (via eventos onFocus/onBlur do React), como
  // reforço extra ao document.activeElement — em alguns teclados Android
  // (principalmente com autocorreção/previsão de texto ativa), o
  // activeElement pode ficar temporariamente inconsistente durante a
  // digitação, o que pode causar duplicação de texto se o campo for
  // reescrito nesse instante.
  const isFocusedRef = useRef<Record<number, boolean>>({});
  const pendingFocusRef = useRef<"title" | "content" | null>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const savedScrollRef = useRef<number>(0);
  const justEnteredEditRef = useRef(false);

  // ── Auto-save draft to localStorage ───────────────────
  const DRAFT_KEY = "note_editor_draft";

  const saveDraftToLocal = useCallback(() => {
    if (!open) return;
    const hasContent = title.trim() || blocks.some(b => (b.type === "text" && b.content?.trim()) || b.type === "image" || b.type === "checklist" || (b.type === "table" && (b.tableItems?.length ?? 0) > 0));
    if (!hasContent) return;
    const draft = {
      noteId: editingNote?.id || null,
      title,
      blocks,
      color: selectedColor,
      timestamp: Date.now(),
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch {}
  }, [open, title, blocks, selectedColor, editingNote]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }, []);

  // Auto-save to localStorage every 2 seconds
  useEffect(() => {
    if (!open) return;
    const interval = setInterval(saveDraftToLocal, 2000);
    return () => clearInterval(interval);
  }, [open, saveDraftToLocal]);

  // Restore scroll position immediately after entering edit mode (before browser paints)
  useLayoutEffect(() => {
    if (!readOnly && justEnteredEditRef.current && scrollContainerRef.current && savedScrollRef.current > 0) {
      scrollContainerRef.current.scrollTop = savedScrollRef.current;
      justEnteredEditRef.current = false;
    }
  });

  // Fix keyboard overlap on mobile — scroll focused element into view when keyboard opens
  useEffect(() => {
    if (!open) return;
    const handleViewportResize = () => {
      if (!window.visualViewport) return;
      const kbHeight = Math.max(0, window.innerHeight - window.visualViewport.height);
      if (kbHeight > 100) {
        const focused = document.activeElement as HTMLElement;
        if (focused && (focused.tagName === "TEXTAREA" || focused.tagName === "INPUT")) {
          setTimeout(() => focused.scrollIntoView({ behavior: "smooth", block: "nearest" }), 80);
        }
      }
    };
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    return () => {
      window.visualViewport?.removeEventListener("resize", handleViewportResize);
    };
  }, [open]);

  /**
   * Proteção contra apagar a nota por engano: devolve true quando NÃO se deve gravar.
   * - nada mudou desde que a nota foi aberta (também evita gastar internet à toa);
   * - o texto está vazio e igual ao que foi carregado (a nota abriu sem texto: gravar isso
   *   apagaria o texto que está na nuvem);
   * - no salvamento automático: o texto está vazio (só um Salvar ou Fechar feito por você
   *   pode gravar uma nota esvaziada de propósito).
   */
  const shouldSkipSave = (serialized: string, auto: boolean): boolean => {
    const base = loadedRef.current;
    if (!base || !editingNote) return false;
    // O texto que está na tela ainda é de OUTRA nota (a tela trocou de nota e ainda não
    // carregou a nova): nunca grava, senão o texto de uma nota iria por cima da outra.
    if (base.id !== editingNote.id) return true;
    const bodyEmpty = !blocksHaveBody(blocks);
    const sameContent = serialized === base.content;
    if (sameContent && bodyEmpty) return true;
    if (sameContent && title === base.title && selectedColor === base.color) return true;
    if (auto && bodyEmpty) return true;
    return false;
  };

  const markSaved = (serialized: string) => {
    if (!editingNote) return;
    loadedRef.current = {
      id: editingNote.id,
      title,
      content: serialized,
      color: selectedColor,
      hadBody: blocksHaveBody(blocks),
    };
  };

  // Auto-sync to cloud every 10 seconds
  useEffect(() => {
    if (!open || !editingNote) return;
    const interval = setInterval(() => {
      const hasContent = title.trim() || blocksToPlainText(blocks).trim();
      if (!hasContent) return;
      const serialized = serializeBlocks(blocks);
      if (shouldSkipSave(serialized, true)) return;
      const imageUrls: string[] = []; // as fotos já ficam dentro do texto da nota (serialized); gravar a lista separada duplicava tudo
      const status = editingNote?.status || "rascunho";
      onSave(title, serialized, imageUrls, selectedColor, "default", "medium", status);
      markSaved(serialized);
    }, 10000);
    return () => clearInterval(interval);
  }, [open, title, blocks, selectedColor, editingNote, onSave]);

  // Save immediately on visibility change (minimize, tab switch) and beforeunload
  useEffect(() => {
    if (!open) return;
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        saveDraftToLocal();
        // Also trigger cloud save
        const hasContent = title.trim() || blocksToPlainText(blocks).trim();
        if (hasContent && editingNote) {
          const serialized = serializeBlocks(blocks);
          if (!shouldSkipSave(serialized, true)) {
            const imageUrls: string[] = []; // as fotos já ficam dentro do texto da nota (serialized); gravar a lista separada duplicava tudo
            const status = editingNote?.status || "rascunho";
            onSave(title, serialized, imageUrls, selectedColor, "default", "medium", status);
            markSaved(serialized);
          }
        }
      }
    };
    const handleBeforeUnload = () => {
      saveDraftToLocal();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [open, saveDraftToLocal, title, blocks, selectedColor, editingNote, onSave]);

  // Voice dictation
  const handleVoiceResult = useCallback((text: string) => {
    if (activeFieldRef.current === "title") {
      setTitle((prev) => (prev + " " + text).trim());
    } else {
      const idx = focusedBlockRef.current;
      setBlocks((prev) => {
        const next = [...prev];
        if (next[idx]?.type === "text") {
          next[idx] = { ...next[idx], content: ((next[idx].content || "") + " " + text).trim() };
        }
        return next;
      });
    }
  }, []);

  const { isListening, isSupported: voiceSupported, toggle: toggleVoice } = useSpeechRecognition(handleVoiceResult);

  // ── Sync on open (with draft recovery) ────────────────
  const lastNoteId = useRef<string | null>(null);
  // Como a nota estava salva quando foi aberta. Serve para nunca gravar por cima dela uma versão
  // vazia (quando o texto não carregou) e para não regravar na nuvem uma nota que não mudou.
  const loadedRef = useRef<{ id: string; title: string; content: string; color: string; hadBody: boolean } | null>(null);
  useEffect(() => {
    if (!open) {
      if (lastNoteId.current !== null) lastNoteId.current = null;
      return;
    }

    const noteId = editingNote?.id ?? "__new__";
    if (lastNoteId.current === noteId) return;

    lastNoteId.current = noteId;
    let recovered = false;
    // Guarda o conteúdo inicial de fato carregado (seja recuperado de
    // rascunho, seja da nota salva) pra usar como ponto de partida do
    // histórico de Desfazer logo abaixo — título e corpo juntos.
    let initialBlocksForHistory: ContentBlock[] = [{ type: "text", content: "" }];
    let initialTitleForHistory = "";
    // Try to recover draft from localStorage
    if (!editingNote) {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const draft = JSON.parse(raw);
          // Only recover if draft is for a new note (no noteId) and less than 1 hour old
          if (!draft.noteId && Date.now() - draft.timestamp < 3600000) {
            setTitle(draft.title || "");
            initialTitleForHistory = draft.title || "";
            const recoveredBlocks = ensureTrailingTextBlock(draft.blocks || [{ type: "text", content: "" }]);
            setBlocks(recoveredBlocks);
            initialBlocksForHistory = recoveredBlocks;
            setSelectedColor(draft.color || NOTE_COLORS[0].value);
            recovered = true;
          }
        }
      } catch {}
    } else {
      // For existing notes, check if there's a more recent draft
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (raw) {
          const draft = JSON.parse(raw);
          if (draft.noteId === editingNote.id && Date.now() - draft.timestamp < 3600000) {
            setTitle(draft.title || "");
            initialTitleForHistory = draft.title || "";
            const recoveredBlocks = draft.blocks || deserializeBlocks(editingNote.content);
            setBlocks(recoveredBlocks);
            initialBlocksForHistory = recoveredBlocks;
            setSelectedColor(draft.color || editingNote.color);
            recovered = true;
          }
        }
      } catch {}
    }
    if (!recovered) {
      if (editingNote) {
        setTitle(editingNote.title);
        initialTitleForHistory = editingNote.title;
        const parsed = deserializeBlocks(editingNote.content);
        const finalBlocks = ensureTrailingTextBlock(parsed);
        setBlocks(finalBlocks);
        initialBlocksForHistory = finalBlocks;
        setSelectedColor(editingNote.color);
      } else if (initialSharedData && (initialSharedData.title || initialSharedData.content)) {
        // Pre-fill from shared content received from another app
        setTitle(initialSharedData.title || "");
        initialTitleForHistory = initialSharedData.title || "";
        const sharedBlocks = [{ type: "text" as const, content: initialSharedData.content || "" }];
        setBlocks(sharedBlocks);
        initialBlocksForHistory = sharedBlocks;
        setSelectedColor(NOTE_COLORS[0].value);
      } else {
        setTitle("");
        initialTitleForHistory = "";
        const emptyBlocks = [{ type: "text" as const, content: "" }];
        setBlocks(emptyBlocks);
        initialBlocksForHistory = emptyBlocks;
        setSelectedColor(NOTE_COLORS[0].value);
      }
    }

    // Corrigido: o histórico de Desfazer agora já nasce com o título e o
    // texto originais da nota (em vez de vazio). Antes disso, o botão só
    // passava a funcionar depois de 2 edições completas, nunca voltava pro
    // texto de antes de qualquer edição, e nunca considerava o título.
    titleRef.current = initialTitleForHistory;
    setHistory([{ title: initialTitleForHistory, blocks: JSON.parse(JSON.stringify(initialBlocksForHistory)) }]);
    setHistoryIdx(0);

    if (editingNote) {
      const savedBlocks = ensureTrailingTextBlock(deserializeBlocks(editingNote.content));
      loadedRef.current = {
        id: editingNote.id,
        title: editingNote.title,
        content: serializeBlocks(savedBlocks),
        color: editingNote.color,
        hadBody: blocksHaveBody(savedBlocks),
      };
    } else {
      loadedRef.current = null;
    }

    // Corrigido: fecha qualquer visualizador de foto ampliada ou editor de
    // desenho que tenha ficado aberto de uma nota anterior — sem isso, a
    // tela da foto "vazava" pra próxima nota que fosse aberta.
    setViewingImage(null);
    setViewZoom(1);
    setViewTx(0);
    setViewTy(0);
    setViewRotation(0);
    setEditingImageIdx(null);
  }, [open, editingNote?.id, initialSharedData?.title, initialSharedData?.content]);

  const [highContrast, setHighContrast] = useState<boolean>(() => localStorage.getItem("editor_high_contrast") === "true");
  const toggleHighContrast = () => {
    setHighContrast((prev) => { localStorage.setItem("editor_high_contrast", String(!prev)); return !prev; });
  };

  const [readingMode, setReadingMode] = useState(false);
  const speech = useSpeech();
  const isSpeaking = speech.speaking;
  // Leitura acompanhada (palavra destacada, toque para continuar)
  const [readDoc, setReadDoc] = useState<ReadDoc | null>(null);
  const [readResumedFrom, setReadResumedFrom] = useState(0);

  // Tabela Manual: calculadora por linha (uma aberta por vez) e foco do campo de valor
  const [calcRow, setCalcRow] = useState<{ blockIdx: number; itemId: string } | null>(null);
  const [calcExpr, setCalcExpr] = useState("");
  // Resultado da conta enquanto você digita: o valor da linha mostra este número, sempre atualizado
  const [calcAoVivo, setCalcAoVivo] = useState<number | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [calcEditIdx, setCalcEditIdx] = useState<number | null>(null); // conta do histórico que está sendo editada
  const [pendingClearCalc, setPendingClearCalc] = useState<{ blockIdx: number; itemId: string; label: string; valor: string; total: number } | null>(null);
  const [calcMin, setCalcMin] = useState<Record<string, boolean>>({});
  const [valorFocadoId, setValorFocadoId] = useState<string | null>(null);
  const [linhaAtivaId, setLinhaAtivaId] = useState<string | null>(null); // linha da tabela com os botões à mostra
  const calcInputRef = useRef<HTMLTextAreaElement>(null);
  const calcPrefillRef = useRef(""); // texto com que a calculadora abriu (se ninguém mexer, confirmar só fecha)
  // Tabela Manual: foco automático no nome da linha recém-inserida e navegação Enter (nome → valor → nova linha)
  const novoItemFocoRef = useRef<string | null>(null);
  const nomeRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const valorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [calcVirgulaAuto, setCalcVirgulaAuto] = useState<boolean>(() => {
    try { return localStorage.getItem("calc_virgula_auto") !== "0"; } catch { return true; }
  });
  // Teclado próprio do app (números e operações) no lugar do teclado do celular ao tocar no valor
  const [tecladoProprio, setTecladoProprio] = useState<boolean>(() => {
    try { return localStorage.getItem("calc_teclado_proprio") !== "0"; } catch { return true; }
  });

  useEffect(() => {
    if (!calcRow) return;
    const el = calcInputRef.current;
    el?.focus();
    const n = el?.value.length ?? 0;
    try { el?.setSelectionRange(n, n); } catch { /* ignora */ }
  }, [calcRow]);

  useEffect(() => {
    if (readOnly || !open) { setCalcRow(null); setLinhaAtivaId(null); }
  }, [readOnly, open]);

  // Com o teclado do app aberto, leva a linha editada para a parte visível da tela
  useEffect(() => {
    if (!calcRow || !tecladoProprio) return;
    const t = window.setTimeout(() => {
      document.getElementById(`linha-${calcRow.itemId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 150);
    return () => window.clearTimeout(t);
  }, [calcRow, tecladoProprio]);

  // Ao fechar a nota, para a leitura em voz alta
  useEffect(() => {
    if (!open) {
      speech.stop();
      setReadDoc(null);
    }
  }, [open, speech.stop]);

  useEffect(() => {
    if (speech.message) toast({ title: "Leitura em voz alta", description: speech.message });
  }, [speech.message]);

  const closeReadAlong = () => {
    speech.stop();
    setReadDoc(null);
  };

  // Leitura em voz alta ACOMPANHADA: abre a tela de leitura, destaca a palavra falada e
  // continua de onde você parou. Roda direto do toque (o Safari/iPhone exige isso).
  const toggleReadAloud = () => {
    if (readDoc) {
      closeReadAlong();
      return;
    }
    if (speech.speaking) {
      speech.stop();
      return;
    }
    const doc = buildReadDoc(
      title,
      blocks.map((b) => ({
        type: b.type,
        content: b.content,
        html: b.type === "text" ? consistentHtml(b) || undefined : undefined,
        items: b.items?.map((it) => ({ text: it.text, checked: !!it.checked, bold: (it as { bold?: boolean }).bold })),
        rows: b.tableItems?.map((it) => ({ nome: it.nome, valor: valorParaExibir(it.valor || "0", false) })),
      }))
    );
    if (doc.sentences.length === 0) {
      toast({ title: "Nada pra ler", description: "Essa nota ainda está vazia." });
      return;
    }

    // Retoma de onde parou da última vez (só se a nota não mudou de tamanho)
    let startIdx = 0;
    try {
      const raw = editingNote?.id ? localStorage.getItem(`readalong_pos_${editingNote.id}`) : null;
      if (raw) {
        const saved = JSON.parse(raw) as { i?: number; n?: number };
        if (typeof saved.i === "number" && saved.n === doc.sentences.length && saved.i > 0 && saved.i < doc.sentences.length) {
          startIdx = saved.i;
        }
      }
    } catch {
      /* sem storage */
    }

    setReadResumedFrom(startIdx);
    setReadDoc(doc);
    speech.playSegments(
      doc.sentences.map((s) => ({ speak: s.speak, prefix: s.prefix })),
      startIdx,
      0
    );
  };

  // ── Tabela Manual: calculadora por linha ─────────────
  // editIdx: posição da conta do histórico que será editada (ao tocar nela); sem isso abre com a última conta
  const abrirCalcTabela = (blockIdx: number, item: TableItem, editIdx?: number) => {
    const hist = item.calc?.historico ?? [];
    let alvo = editIdx !== undefined && hist[editIdx] ? editIdx : null;
    setCalcError(null);
    // Abre com o que está escrito no valor, para corrigir: tocando numa conta do histórico, abre com aquela conta;
    // se a linha tem conta, abre com a última conta (salvar a substitui); senão, abre com o próprio valor
    // (número ou porcentagem). Para continuar somando, é só tocar em +.
    const valorAtual = item.valor.trim().replace(/R\$/gi, "").trim();
    let inicial = "";
    if (alvo !== null) inicial = hist[alvo].expressao;
    else if (hist.length > 0) { alvo = hist.length - 1; inicial = hist[alvo].expressao; }
    else if (valorAtual && (tableValorEhPorcentagem(item.valor) || evaluateExpression(valorAtual) !== null)) inicial = valorAtual;
    setCalcEditIdx(alvo);
    setCalcAoVivo(null);
    virgulaManualRef.current = false;
    calcPrefillRef.current = inicial;
    setCalcExpr(inicial);
    setCalcRow({ blockIdx, itemId: item.id });
  };

  const fecharCalcTabela = () => {
    setCalcRow(null);
    setCalcError(null);
    setCalcEditIdx(null);
    setLinhaAtivaId(null); // salvou/fechou: calculadora e lixeira da linha somem
  };

  const aplicarCalc = (exprBruta: string): boolean => {
    if (!calcRow) return false;
    const expr = exprBruta.trim();
    if (!expr || expr === calcPrefillRef.current.trim()) { fecharCalcTabela(); return true; }
    // Porcentagem digitada no teclado (ex.: −10%): vira o valor da linha como texto, sem histórico de conta
    const pct = expr.match(/^([+\-−])?\s*(\d+(?:[.,]\d+)?)\s*%$/);
    if (pct) {
      updateTableItem(calcRow.blockIdx, calcRow.itemId, { valor: `${pct[1] === "-" || pct[1] === "−" ? "-" : ""}${pct[2]}%`, calc: undefined });
      fecharCalcTabela();
      return true;
    }
    const resultado = evaluateExpression(expr);
    if (resultado === null) {
      setCalcError("Conta inválida. Exemplo: 3.99 + 8.32 + 25.78");
      return false;
    }
    const itemAtual = blocks[calcRow.blockIdx]?.tableItems?.find((i) => i.id === calcRow.itemId);
    // Editando uma conta do histórico: ela é substituída (e passa a ser a mais recente); senão, entra uma nova
    const anteriores = (itemAtual?.calc?.historico ?? []).filter((_, i) => i !== calcEditIdx);
    const historico = [...anteriores, { expressao: expr, resultado }].slice(-10);
    updateTableItem(calcRow.blockIdx, calcRow.itemId, {
      valor: resultado.toFixed(2).replace(".", ","),
      calc: { historico },
    });
    fecharCalcTabela();
    return true;
  };

  // Confirmar (tique verde, Próximo): se a conta estiver inválida, avisa e continua aberta
  const confirmarCalcTabela = (): boolean => aplicarCalc(calcExpr);

  // Sair (tocar de novo no valor, no ícone da calculadora ou ir para o Nome): sempre deixa sair.
  // Conta incompleta (sobrou um operador no fim) é aparada; "−" sozinho vira o valor "-";
  // se nada servir, fecha e mantém o valor que a linha já tinha.
  const sairCalcTabela = () => {
    if (!calcRow) return;
    const { blockIdx, itemId } = calcRow;
    let expr = calcExpr.trim();
    if (!expr || expr === calcPrefillRef.current.trim()) { fecharCalcTabela(); return; }
    if (/^[−-]$/.test(expr)) {
      updateTableItem(blockIdx, itemId, { valor: "-", calc: undefined });
      fecharCalcTabela();
      return;
    }
    expr = expr.replace(/[\s+−×÷*/-]+$/, "").trim(); // tira operador sobrando no fim
    if (!expr) { fecharCalcTabela(); return; }
    if (/^[\d.,]+$/.test(expr)) {
      // só um número: vira o valor da linha, sem histórico de conta
      const itemAtual = blocks[blockIdx]?.tableItems?.find((i) => i.id === itemId);
      if (expr !== (itemAtual?.valor ?? "")) updateTableItem(blockIdx, itemId, { valor: expr, calc: undefined });
      fecharCalcTabela();
      return;
    }
    if (!aplicarCalc(expr)) fecharCalcTabela();
  };

  const alternarVirgulaAuto = () => {
    setCalcVirgulaAuto((prev) => {
      try { localStorage.setItem("calc_virgula_auto", prev ? "0" : "1"); } catch { /* sem storage */ }
      return !prev;
    });
    calcInputRef.current?.focus();
  };

  // ── Edição da conta no ponto onde está o cursor (toque no campo posiciona o cursor) ──
  const calcExprRef = useRef(calcExpr);
  calcExprRef.current = calcExpr;
  const calcCursorRef = useRef<number | null>(null);
  // O campo da conta cresce para baixo quando a conta enche a linha (a conta inteira fica à vista)
  useLayoutEffect(() => {
    const el = calcInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [calcExpr, calcRow, tecladoProprio]);
  // Valor ao vivo: a cada toque recalcula; conta incompleta (operador sobrando) usa o que já está completo;
  // se ainda não dá para calcular, mantém o último resultado correto
  useEffect(() => {
    if (!calcRow) { setCalcAoVivo(null); return; }
    const expr = calcExpr.trim();
    if (!expr) { setCalcAoVivo(0); return; }
    const aparada = expr.replace(/[\s+−×÷*/-]+$/, "").trim();
    if (!aparada) return;
    const r = evaluateExpression(aparada);
    if (r !== null) setCalcAoVivo(r);
  }, [calcExpr, calcRow]);
  const virgulaManualRef = useRef(false); // número atual com vírgula/ponto digitados à mão (sem vírgula automática)
  const lerCursor = () => {
    const expr = calcExprRef.current;
    const el = calcInputRef.current;
    const ini = Math.min(el?.selectionStart ?? expr.length, expr.length);
    const fim = Math.min(el?.selectionEnd ?? ini, expr.length);
    return { expr, ini, fim, len: expr.length };
  };
  const escreverCalc = (novo: string, pos: number) => {
    setCalcError(null);
    if (novo === calcExprRef.current) {
      const el = calcInputRef.current;
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* ignora */ } }
      return;
    }
    calcCursorRef.current = pos;
    calcExprRef.current = novo;
    setCalcExpr(novo);
  };
  useEffect(() => {
    if (calcCursorRef.current === null) return;
    const pos = calcCursorRef.current;
    calcCursorRef.current = null;
    const el = calcInputRef.current;
    if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* ignora */ } }
  }, [calcExpr]);

  const inserirOperadorCalc = (op: string) => {
    virgulaManualRef.current = false; // novo número: volta a vírgula automática
    const { expr, ini, fim, len } = lerCursor();
    if (op === "(" || op === ")") { escreverCalc(expr.slice(0, ini) + op + expr.slice(fim), ini + 1); return; }
    if (ini === len && fim === len) {
      const f = `${expr.trimEnd()} ${op} `;
      escreverCalc(f, f.length);
      return;
    }
    const ins = ` ${op} `;
    escreverCalc(expr.slice(0, ini) + ins + expr.slice(fim), ini + ins.length);
  };

  // ── Teclado próprio (números, operações e porcentagem) ──
  const aplicarCalcAuto = (t: string) => (calcVirgulaAuto ? aplicarVirgulaAutomatica(t) : t);
  const tecladoDigito = (d: string) => {
    const { expr, ini, fim, len } = lerCursor();
    const novo = expr.slice(0, ini) + d + expr.slice(fim);
    if (ini === len && fim === len) {
      // número com vírgula digitada à mão: os dígitos entram como digitados
      const f = virgulaManualRef.current ? novo : aplicarCalcAuto(novo);
      escreverCalc(f, f.length);
    } else escreverCalc(novo, ini + d.length); // no meio da conta não mexe nas casas decimais
  };
  // Vírgula e ponto: a partir daqui o número é digitado como está (sem a vírgula automática)
  const tecladoSeparador = (sep: "," | ".") => {
    const { expr, ini, fim, len } = lerCursor();
    const antes = expr.slice(0, ini);
    const tok = (antes.match(/[\d.,]*$/) ?? [""])[0];
    if (ini === len && fim === len) {
      let base = antes;
      if (tok && /[.,]/.test(tok)) {
        if (virgulaManualRef.current) return; // já tem separador neste número
        // desfaz a vírgula automática: volta aos dígitos que foram digitados (0,01 → 1)
        const digitos = String(parseInt(tok.replace(/\D/g, ""), 10) || 0);
        base = antes.slice(0, antes.length - tok.length) + digitos;
      } else if (!tok) {
        base = antes + "0";
      }
      virgulaManualRef.current = true;
      const f = base + sep;
      escreverCalc(f, f.length);
      return;
    }
    if (/[.,]/.test(tok)) return;
    escreverCalc(antes + sep + expr.slice(fim), ini + 1);
  };
  const tecladoLimpar = () => { virgulaManualRef.current = false; escreverCalc("", 0); };
  const tecladoApagar = () => {
    const { expr, ini, fim, len } = lerCursor();
    if (fim > ini) { escreverCalc(expr.slice(0, ini) + expr.slice(fim), ini); return; }
    if (ini === 0) return;
    const antes = expr.slice(0, ini);
    const depois = expr.slice(ini);
    const m = antes.match(/\s*[+−×÷-]\s*$/);
    const cortar = /\s[+−×÷-]\s*$/.test(antes) && m ? m[0].length : 1;
    const novoAntes = antes.slice(0, antes.length - cortar);
    if (ini === len) {
      // no fim: refaz as casas decimais automáticas só se o número tinha vírgula (inteiro e porcentagem ficam como estão)
      const ultimo = antes.match(/[\d.,%]+$/);
      const f = !virgulaManualRef.current && ultimo && ultimo[0].includes(",") ? aplicarCalcAuto(novoAntes) : novoAntes;
      if (/[.,]$/.test(antes)) virgulaManualRef.current = false; // apagou o separador digitado à mão
      escreverCalc(f, f.length);
    } else {
      escreverCalc(novoAntes + depois, novoAntes.length);
    }
  };
  const tecladoPercent = () => {
    const { expr, ini, fim, len } = lerCursor();
    if (ini !== len || fim !== len) { escreverCalc(expr.slice(0, ini) + "%" + expr.slice(fim), ini + 1); return; }
    const m = expr.match(/[\d.,]+$/);
    if (!m) return;
    // volta os centavos automáticos (0,10 → 10): a porcentagem é digitada como número inteiro
    const num = calcVirgulaAuto ? String(parseInt(m[0].replace(/\D/g, ""), 10) || 0) : m[0];
    const f = `${expr.slice(0, expr.length - m[0].length)}${num}%`;
    escreverCalc(f, f.length);
  };
  // Próximo: lança o valor e vai para uma linha nova (foco no Nome); se a última linha já está vazia, vai para ela
  const tecladoProximo = () => {
    if (!calcRow) return;
    const { blockIdx, itemId } = calcRow;
    if (!confirmarCalcTabela()) return;
    const itens = blocks[blockIdx]?.tableItems ?? [];
    const ultima = itens[itens.length - 1];
    if (ultima && ultima.id !== itemId && !ultima.nome.trim() && !(ultima.valor ?? "").trim()) {
      nomeRefs.current[ultima.id]?.focus();
    } else {
      addTableItemAfter(blockIdx);
    }
  };
  const alternarTeclado = (proprio: boolean) => {
    setTecladoProprio(proprio);
    try { localStorage.setItem("calc_teclado_proprio", proprio ? "1" : "0"); } catch { /* sem storage */ }
    if (!proprio) window.setTimeout(() => calcInputRef.current?.focus(), 60);
  };

  const themeBase = getTheme(selectedColor);
  const isDark = selectedColor === "bg-gray-800";
  const theme = highContrast
    ? { ...themeBase, textMuted: isDark ? "#EEEEEE" : "#000000", lines: isDark ? "#888888" : "#444444" }
    : themeBase;
  const textColor = highContrast ? (isDark ? "#FFFFFF" : "#000000") : (isDark ? "#E0E0E0" : "#1A1A2E");
  const placeholderColor = isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.3)";
  // Cor do contorno desenhado em volta do trecho selecionado (o fundo da seleção fica transparente).
  const selectionOutline = isDark ? "#5EEAD4" : "#0F766E";

  // ── Undo / Redo ──────────────────────────────────────
  // Corrigido: antes, um único "Desfazer" apagava um trecho inteiro de
  // texto de uma vez (tudo que foi digitado numa sequência sem pausa).
  // Agora cada edição vira um ponto próprio no histórico, então o Desfazer
  // volta aos poucos, na ordem que foi digitado — inclusive letra por letra,
  // se for isso que a pessoa continuar apertando.
  // Importante: aqui usamos cópia RASA (só o array, não o conteúdo de cada
  // bloco) porque cada edição já troca o bloco por um objeto novo em vez de
  // alterar o antigo — então o histórico pode reaproveitar os blocos que não
  // mudaram (como fotos) sem duplicar esse conteúdo pesado a cada tecla.
  // Corrigido: o histórico agora grava o TÍTULO junto com o corpo (antes só
  // gravava o corpo, então o Desfazer nunca tinha efeito no campo de título).
  const pushHistory = useCallback((newBlocks: ContentBlock[]) => {
    setHistory((h) => {
      const trimmed = h.slice(0, historyIdx + 1);
      const limited = [...trimmed, { title: titleRef.current, blocks: [...newBlocks] }].slice(-100);
      return limited;
    });
    setHistoryIdx((i) => Math.min(i + 1, 99));
  }, [historyIdx]);

  const undo = useCallback(() => {
    if (historyIdx <= 0) return;
    const prev = history[historyIdx - 1];
    if (prev) {
      setBlocks([...prev.blocks]);
      setTitle(prev.title);
      titleRef.current = prev.title;
      setHistoryIdx((i) => i - 1);
    }
  }, [historyIdx, history]);

  const redo = useCallback(() => {
    if (historyIdx >= history.length - 1) return;
    const next = history[historyIdx + 1];
    if (next) {
      setBlocks([...next.blocks]);
      setTitle(next.title);
      titleRef.current = next.title;
      setHistoryIdx((i) => i + 1);
    }
  }, [historyIdx, history]);

  // Mantém titleRef sempre atualizado (usado pelo pushHistory acima, pra
  // não gravar um título "atrasado" quando o corpo da nota é editado logo
  // depois de mexer no título).
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  // Chamado pelo campo de título — grava um ponto de histórico a cada
  // alteração, igual já acontece no corpo da nota (letra por letra).
  const updateTitle = (value: string) => {
    setTitle(value);
    titleRef.current = value;
    setBlocks((currentBlocks) => {
      pushHistory(currentBlocks);
      return currentBlocks;
    });
  };

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, undo, redo]);

  // ── Block operations ─────────────────────────────────
  // Sincroniza o texto rico (com cores/negrito por trecho) depois de digitar
  const updateTextBlockRich = (index: number) => {
    const el = richTextRefs.current[index];
    if (!el) return;
    const html = el.innerHTML;
    const plain = el.innerText;
    setBlocks((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], content: plain, contentHtml: html };
      pushHistory(next);
      return next;
    });
  };

  // Aplica cor/negrito só no trecho selecionado (ou no que for digitado a partir
  // do cursor, se nada estiver selecionado) — é o mesmo mecanismo usado em editores
  // de texto de verdade (Gmail, Word Online, etc.)
  const applyInlineFormat = (index: number, command: "foreColor" | "bold", value?: string) => {
    const el = richTextRefs.current[index];
    if (!el) return;
    el.focus();
    try {
      document.execCommand("styleWithCSS", false as any, "true" as any);
      document.execCommand(command, false, value);
    } catch { /* navegador sem suporte a esse comando específico */ }
    updateTextBlockRich(index);
  };

  // Atualiza a imagem de um bloco (usado depois de editar/desenhar em cima dela)
  const updateImageBlock = (index: number, newUrl: string) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[index]?.type !== "image") return prev;
      next[index] = { ...next[index], url: newUrl };
      pushHistory(next);
      return next;
    });
    toast({ title: "✏️ Imagem editada", description: "As marcações foram salvas na imagem." });
  };

  // Aplica formatação (cor, fonte, negrito, alinhamento) ao bloco de texto em foco
  const applyTextStyle = (index: number, partial: Partial<TextStyle>) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[index]?.type !== "text") return prev;
      next[index] = { ...next[index], style: { ...(next[index].style || {}), ...partial } };
      pushHistory(next);
      return next;
    });
  };

  // Divide um bloco de texto em dois, no ponto onde está o cursor — assim cada
  // metade pode ter uma cor/fonte/formatação diferente da outra.
  const splitBlockAtCursor = (index: number) => {
    const el = richTextRefs.current[index];
    const block = blocks[index];
    if (!el || !block || block.type !== "text") return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !el.contains(selection.getRangeAt(0).startContainer)) {
      toast({ title: "Toque no texto primeiro", description: "Toque no ponto onde quer dividir antes de usar esse botão." });
      return;
    }
    const cursorRange = selection.getRangeAt(0);

    const beforeRange = document.createRange();
    beforeRange.setStart(el, 0);
    beforeRange.setEnd(cursorRange.startContainer, cursorRange.startOffset);
    const beforeContainer = document.createElement("div");
    beforeContainer.appendChild(beforeRange.cloneContents());
    const beforeHtml = beforeContainer.innerHTML;
    const beforeText = htmlToPlainText(beforeHtml);

    const afterRange = document.createRange();
    afterRange.setStart(cursorRange.startContainer, cursorRange.startOffset);
    afterRange.setEnd(el, el.childNodes.length);
    const afterContainer = document.createElement("div");
    afterContainer.appendChild(afterRange.cloneContents());
    const afterHtml = afterContainer.innerHTML;
    const afterText = htmlToPlainText(afterHtml);

    if (!beforeText.trim() || !afterText.trim()) {
      toast({ title: "Posicione o cursor no meio do texto", description: "Toque no ponto exato onde quer separar as duas partes antes de dividir." });
      return;
    }

    setBlocks((prev) => {
      const next = [...prev];
      next.splice(index, 1,
        { type: "text", content: beforeText, contentHtml: beforeHtml, style: block.style },
        { type: "text", content: afterText, contentHtml: afterHtml, style: block.style },
      );
      pushHistory(next);
      return next;
    });

    setActiveBlockIdx(index + 1);
    focusedBlockRef.current = index + 1;
    pendingFocusRef.current = "content";
    pendingCursorRef.current = 0;
    toast({ title: "✂️ Texto dividido em dois blocos", description: "Agora cada parte pode ter sua própria formatação." });
  };

  // Compress image before inserting (max 1000px, quality 0.75 — bom
  // equilíbrio entre espaço no banco e legibilidade de documentos/recibos)
  const compressImage = (file: File, maxSize = 1000, quality = 0.75): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const original = ev.target?.result as string;
        const img = new Image();

        const drawAndResolve = () => {
          try {
            const canvas = document.createElement("canvas");
            let w = img.naturalWidth || img.width;
            let h = img.naturalHeight || img.height;
            if (w > maxSize || h > maxSize) {
              if (w > h) { h = Math.round((h * maxSize) / w); w = maxSize; }
              else { w = Math.round((w * maxSize) / h); h = maxSize; }
            }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              // Canvas context unavailable — use original file as-is
              resolve(original);
              return;
            }
            // Preenche com fundo branco antes de desenhar — necessário para
            // PNGs com transparência (ex: screenshots do celular), que
            // ficariam pretos ao converter para JPEG sem esse passo.
            ctx.fillStyle = "#FFFFFF";
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);

            // Sanity check: amostra alguns pixels pra detectar canvas em branco.
            // Prints de tela (screenshots) são maiores/mais complexos de decodificar
            // que fotos normais, e em alguns navegadores/WebViews o evento "load"
            // pode disparar antes do bitmap estar 100% pronto pra ser desenhado —
            // isso resulta num canvas todo branco mesmo sem erro nenhum.
            if (isCanvasBlank(ctx, w, h)) {
              resolve(original);
              return;
            }

            const dataUrl = canvas.toDataURL("image/jpeg", quality);
            // Sanity check adicional: resultado suspeito de pequeno (canvas em branco/preto)
            if (dataUrl.length < 1000) {
              resolve(original);
              return;
            }
            resolve(dataUrl);
          } catch {
            // Any error: fall back to original
            resolve(original);
          }
        };

        // img.decode() garante que o bitmap está totalmente decodificado antes
        // de desenhar no canvas — evita a corrida com "onload" em imagens grandes
        // (como screenshots), que pode gerar uma imagem em branco de forma
        // intermitente. Em navegadores sem suporte a decode(), cai pro onload.
        if (typeof img.decode === "function") {
          img.src = original;
          img
            .decode()
            .then(drawAndResolve)
            .catch(() => {
              // decode() falhou (imagem corrompida ou navegador recusou) — tenta onload como último recurso
              img.onload = drawAndResolve;
              img.onerror = () => resolve(original);
            });
        } else {
          img.onload = drawAndResolve;
          img.onerror = () => resolve(original);
          img.src = original;
        }
      };
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  };

  // Verifica se um canvas está inteiramente (ou quase) branco, amostrando uma
  // grade de pixels em vez de ler o canvas inteiro (mais rápido e leve).
  const isCanvasBlank = (ctx: CanvasRenderingContext2D, w: number, h: number): boolean => {
    try {
      const samplesPerAxis = 8;
      let whiteCount = 0;
      let total = 0;
      for (let i = 1; i < samplesPerAxis; i++) {
        for (let j = 1; j < samplesPerAxis; j++) {
          const x = Math.floor((w * i) / samplesPerAxis);
          const y = Math.floor((h * j) / samplesPerAxis);
          const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
          total++;
          if (r > 250 && g > 250 && b > 250) whiteCount++;
        }
      }
      // Se praticamente todos os pontos amostrados forem brancos, provavelmente
      // o desenho falhou e sobrou só o fundo branco preenchido antes.
      return total > 0 && whiteCount / total > 0.97;
    } catch {
      // Se não conseguir ler pixels (ex: canvas tainted), não bloqueia o fluxo normal
      return false;
    }
  };

  // ── Reduzir fotos da nota (botão no menu ⋮) ──
  // Cada toque diminui as fotos mais um pouco (lado maior x0,8 e JPEG mais leve),
  // até chegar no mínimo (500 px) e não diminuir mais. Mostra o tamanho em MB.
  const LADO_MINIMO_FOTO = 500;
  const bytesDeDataUrl = (url: string): number => {
    if (!url.startsWith("data:")) return 0;
    const i = url.indexOf(",");
    return i < 0 ? 0 : Math.round(((url.length - i - 1) * 3) / 4);
  };
  const formatarMB = (bytes: number) => `${(bytes / 1048576).toFixed(2).replace(".", ",")} MB`;

  const reduzirDataUrl = (url: string): Promise<string> =>
    new Promise((resolve) => {
      if (!url.startsWith("data:image")) { resolve(url); return; }
      const img = new Image();
      const desenhar = () => {
        try {
          const w0 = img.naturalWidth || img.width;
          const h0 = img.naturalHeight || img.height;
          if (!w0 || !h0) { resolve(url); return; }
          const lado = Math.max(w0, h0);
          const novoLado = lado > LADO_MINIMO_FOTO ? Math.max(LADO_MINIMO_FOTO, Math.round(lado * 0.8)) : lado;
          const escala = novoLado / lado;
          const w = Math.max(1, Math.round(w0 * escala));
          const h = Math.max(1, Math.round(h0 * escala));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(url); return; }
          ctx.fillStyle = "#FFFFFF"; // PNG com transparência não pode ficar preto no JPEG
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const novo = canvas.toDataURL("image/jpeg", lado > LADO_MINIMO_FOTO ? 0.7 : 0.55);
          // Só vale se ficou menor e não é um resultado suspeito (vazio).
          resolve(novo.length < 1000 || novo.length >= url.length ? url : novo);
        } catch {
          resolve(url);
        }
      };
      if (typeof img.decode === "function") {
        img.src = url;
        img.decode().then(desenhar).catch(() => { img.onload = desenhar; img.onerror = () => resolve(url); });
      } else {
        img.onload = desenhar;
        img.onerror = () => resolve(url);
        img.src = url;
      }
    });

  const indicesFotos = blocks.map((b, i) => (b.type === "image" ? i : -1)).filter((i) => i >= 0);
  const temFotos = indicesFotos.length > 0;
  const bytesFotos = indicesFotos.reduce((soma, i) => soma + bytesDeDataUrl(blocks[i].url || ""), 0);
  const fotosSig = indicesFotos.map((i) => (blocks[i].url || "").length).join(",");
  const fotosNoMinimo = temFotos && fotosNoMinimoSig === fotosSig;

  const reduzirFotosDaNota = async () => {
    if (reduzindoFotos || !temFotos) return;
    setReduzindoFotos(true);
    try {
      const urlsAntes = indicesFotos.map((i) => blocks[i].url || "");
      const antes = urlsAntes.reduce((soma, u) => soma + bytesDeDataUrl(u), 0);
      const novas = await Promise.all(urlsAntes.map((u) => reduzirDataUrl(u)));
      const depois = novas.reduce((soma, u) => soma + bytesDeDataUrl(u), 0);
      if (depois >= antes * 0.95) {
        // Quase não diminuiu mais: chegou no mínimo.
        setFotosNoMinimoSig(fotosSig);
        toast({ title: "Fotos já estão no mínimo", description: `Tamanho: ${formatarMB(antes)}. Reduzir mais estragaria a imagem.` });
        return;
      }
      setBlocks((prev) => {
        const next = [...prev];
        indicesFotos.forEach((i, k) => {
          if (next[i]?.type === "image" && next[i].url === urlsAntes[k]) next[i] = { ...next[i], url: novas[k] };
        });
        pushHistory(next);
        return next;
      });
      toast({ title: "📉 Fotos reduzidas", description: `${formatarMB(antes)} → ${formatarMB(depois)}` });
    } finally {
      setReduzindoFotos(false);
    }
  };

  const insertImageAtBlock = async (file: File) => {
    const url = await compressImage(file);
    const idx = focusedBlockRef.current;
    setBlocks((prev) => {
      const next = [...prev];
      next.splice(idx + 1, 0, { type: "image", url }, { type: "text", content: "" });
      pushHistory(next);
      return next;
    });
    toast({ title: "📷 Imagem adicionada", description: "Imagem comprimida e inserida na nota." });
  };

  // Várias fotos de uma vez: comprime todas e insere juntas, na ordem em que foram escolhidas,
  // logo depois do cursor (inserir uma por uma deixava a ordem invertida).
  const insertImagesAtBlock = async (files: File[]) => {
    const urls: string[] = [];
    for (const f of files) {
      try {
        urls.push(await compressImage(f));
      } catch {
        // foto que não pôde ser lida é pulada; as outras continuam
      }
    }
    if (urls.length === 0) return;
    const idx = focusedBlockRef.current;
    setBlocks((prev) => {
      const next = [...prev];
      const novos: ContentBlock[] = [];
      for (const url of urls) novos.push({ type: "image", url }, { type: "text", content: "" });
      next.splice(idx + 1, 0, ...novos);
      pushHistory(next);
      return next;
    });
    toast({
      title: urls.length === 1 ? "📷 Imagem adicionada" : `📷 ${urls.length} imagens adicionadas`,
      description: urls.length === 1 ? "Imagem comprimida e inserida na nota." : "Imagens comprimidas e inseridas na nota, na ordem escolhida.",
    });
  };

  // ── Cortar ao adicionar: cada foto escolhida abre o editor no modo corte ANTES de ser comprimida,
  //    assim a parte que você mantém aproveita a melhor qualidade. Todas entram juntas no fim, na ordem.
  const toggleCropOnAdd = () => {
    setCropOnAdd((v) => {
      const n = !v;
      try { localStorage.setItem("nb_crop_on_add", n ? "1" : "0"); } catch {}
      return n;
    });
  };

  const finishAddCropQueue = async () => {
    const q = addCropQueueRef.current;
    addCropQueueRef.current = null;
    setAddCrop(null);
    if (q && q.results.length > 0) await insertImagesAtBlock(q.results);
  };

  const openAddCropAt = async (i: number) => {
    const q = addCropQueueRef.current;
    if (!q) return;
    try {
      const big = await compressImage(q.files[i], 2400, 0.92);
      setAddCrop({ dataUrl: big, index: i + 1, total: q.files.length });
    } catch {
      // não conseguiu preparar essa foto para cortar: entra inteira
      q.results.push(q.files[i]);
      await advanceAddCrop();
    }
  };

  const advanceAddCrop = async () => {
    const q = addCropQueueRef.current;
    if (!q) return;
    q.i += 1;
    setAddCrop(null); // fecha a foto anterior enquanto prepara a próxima (evita toque duplo)
    if (q.i < q.files.length) await openAddCropAt(q.i);
    else await finishAddCropQueue();
  };

  const addPhotos = async (files: File[]) => {
    if (files.length === 0) return;
    if (!cropOnAdd) { await insertImagesAtBlock(files); return; }
    try {
      addCropQueueRef.current = { files, i: 0, results: [] };
      await openAddCropAt(0);
    } catch {
      addCropQueueRef.current = null;
      setAddCrop(null);
      await insertImagesAtBlock(files);
    }
  };

  const removeImageBlock = (index: number) => {
    setBlocks((prev) => {
      const next = prev.filter((_, i) => i !== index);
      const merged: ContentBlock[] = [];
      for (const block of next) {
        const last = merged[merged.length - 1];
        if (block.type === "text" && last?.type === "text") {
          last.content = (last.content || "") + "\n" + (block.content || "");
        } else {
          merged.push({ ...block });
        }
      }
      if (merged.length === 0) merged.push({ type: "text", content: "" });
      pushHistory(merged);
      return merged;
    });
  };

  // Galeria no app do celular: abre o seletor do Android deixando marcar várias fotos de uma vez.
  // Se o seletor de várias fotos falhar por algum motivo, volta ao seletor de uma foto (como era antes).
  const pickManyFromGallery = async (): Promise<File[]> => {
    try {
      const { Camera } = await import("@capacitor/camera");
      const res = await Camera.pickImages({ quality: 85 });
      const files: File[] = [];
      for (let i = 0; i < res.photos.length; i++) {
        const ph = res.photos[i];
        if (!ph.webPath) continue;
        const resp = await fetch(ph.webPath);
        const blob = await resp.blob();
        const ext = (ph.format || "jpeg").replace("jpg", "jpeg");
        files.push(new File([blob], `foto_${Date.now()}_${i}.${ext === "jpeg" ? "jpg" : ext}`, { type: blob.type || `image/${ext}` }));
      }
      return files;
    } catch (err) {
      const msg = String((err as any)?.message || err || "");
      if (/cancel/i.test(msg)) return []; // você fechou a galeria sem escolher
      const one = await takeNativePhoto("gallery");
      return one ? [one] : [];
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    // Várias imagens de uma vez, na ordem escolhida
    const lista = Array.from(files);
    e.target.value = "";
    await addPhotos(lista);
  };

  // ── Checklist operations ─────────────────────────────
  const addChecklist = () => {
    const idx = focusedBlockRef.current;
    const newItem: ChecklistItem = { id: crypto.randomUUID(), text: "", checked: false };
    setBlocks((prev) => {
      const next = [...prev];
      // If current block is already a checklist, add item to it
      if (next[idx]?.type === "checklist" && next[idx].items) {
        next[idx] = { ...next[idx], items: [...next[idx].items!, newItem] };
      } else {
        // Insert new checklist block after current, followed by an empty text line
        // (same pattern used when inserting a photo) so there's always somewhere
        // to keep typing below it, even if it becomes the last block in the note.
        next.splice(idx + 1, 0, { type: "checklist", items: [newItem] }, { type: "text", content: "" });
      }
      pushHistory(next);
      return next;
    });
  };

  const updateChecklistItem = (blockIdx: number, itemId: string, updates: Partial<ChecklistItem>) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "checklist" && next[blockIdx].items) {
        next[blockIdx] = {
          ...next[blockIdx],
          items: next[blockIdx].items!.map((item) =>
            item.id === itemId ? { ...item, ...updates } : item
          ),
        };
      }
      pushHistory(next);
      return next;
    });
  };

  const removeChecklistItem = (blockIdx: number, itemId: string) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "checklist" && next[blockIdx].items) {
        const remaining = next[blockIdx].items!.filter((item) => item.id !== itemId);
        if (remaining.length === 0) {
          // Remove the whole checklist block
          next.splice(blockIdx, 1);
          if (next.length === 0) next.push({ type: "text", content: "" });
        } else {
          next[blockIdx] = { ...next[blockIdx], items: remaining };
        }
      }
      pushHistory(next);
      return next;
    });
  };

  const addChecklistItemAfter = (blockIdx: number) => {
    const newItem: ChecklistItem = { id: crypto.randomUUID(), text: "", checked: false };
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "checklist" && next[blockIdx].items) {
        next[blockIdx] = { ...next[blockIdx], items: [...next[blockIdx].items!, newItem] };
      }
      return next;
    });
  };

  // ── Tabela Manual: operações ─────────────────────────
  const addTable = () => {
    const idx = focusedBlockRef.current;
    const newItem: TableItem = { id: crypto.randomUUID(), nome: "", valor: "", marcado: true };
    novoItemFocoRef.current = newItem.id; // o campo Nome da linha nova já abre focado
    setBlocks((prev) => {
      const next = [...prev];
      // Se o bloco atual já é uma tabela, adiciona item nela
      if (next[idx]?.type === "table" && next[idx].tableItems) {
        next[idx] = { ...next[idx], tableItems: [...next[idx].tableItems!, newItem] };
      } else {
        // Insere novo bloco de tabela após o atual, seguido de uma linha de texto vazia
        // (mesmo padrão usado ao inserir uma foto) — assim sempre dá pra continuar
        // escrevendo depois da tabela, mesmo se ela virar o último bloco da nota.
        next.splice(idx + 1, 0, { type: "table", tableItems: [newItem] }, { type: "text", content: "" });
      }
      pushHistory(next);
      return next;
    });
  };

  const updateTableItem = (blockIdx: number, itemId: string, updates: Partial<TableItem>) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "table" && next[blockIdx].tableItems) {
        next[blockIdx] = {
          ...next[blockIdx],
          tableItems: next[blockIdx].tableItems!.map((item) =>
            item.id === itemId ? { ...item, ...updates } : item
          ),
        };
      }
      pushHistory(next);
      return next;
    });
  };

  const removeTableItem = (blockIdx: number, itemId: string) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "table" && next[blockIdx].tableItems) {
        const remaining = next[blockIdx].tableItems!.filter((item) => item.id !== itemId);
        if (remaining.length === 0) {
          // Remove o bloco de tabela inteiro
          next.splice(blockIdx, 1);
          if (next.length === 0) next.push({ type: "text", content: "" });
        } else {
          next[blockIdx] = { ...next[blockIdx], tableItems: remaining };
        }
      }
      pushHistory(next);
      return next;
    });
  };

  const addTableItemAfter = (blockIdx: number) => {
    const newItem: TableItem = { id: crypto.randomUUID(), nome: "", valor: "", marcado: true };
    novoItemFocoRef.current = newItem.id; // o campo Nome da linha nova já abre focado
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "table" && next[blockIdx].tableItems) {
        next[blockIdx] = { ...next[blockIdx], tableItems: [...next[blockIdx].tableItems!, newItem] };
      }
      return next;
    });
  };

  // Enter no campo Valor: lança a linha (o valor já fica salvo ao digitar) e abre uma linha nova
  // com o foco no Nome. Se a última linha da tabela já está vazia, só leva o foco até ela
  // (não cria linhas vazias repetidas).
  const confirmarValorTabela = (blockIdx: number, itemId: string) => {
    const itens = blocks[blockIdx]?.tableItems ?? [];
    const atual = itens.find((it) => it.id === itemId);
    const ultima = itens[itens.length - 1];
    const vazia = (it?: TableItem) => !!it && !it.nome.trim() && !(it.valor ?? "").trim();
    if (vazia(atual)) {
      // linha ainda vazia: não cria outra, apenas volta para o Nome dela
      nomeRefs.current[itemId]?.focus();
      return;
    }
    if (ultima && ultima.id !== itemId && vazia(ultima)) {
      nomeRefs.current[ultima.id]?.focus();
      return;
    }
    addTableItemAfter(blockIdx);
  };

  const updateTableTitle = (blockIdx: number, title: string) => {
    setBlocks((prev) => {
      const next = [...prev];
      if (next[blockIdx]?.type === "table") {
        next[blockIdx] = { ...next[blockIdx], tableTitle: title };
      }
      pushHistory(next);
      return next;
    });
  };

  // Guarda o nome customizado da barra "Soma Total" na 1ª tabela da nota (é o
  // mesmo valor pra nota inteira, não por tabela — só precisa de um lugar pra ficar)
  const updateSomaTotalLabel = (label: string) => {
    setBlocks((prev) => {
      const next = [...prev];
      const firstTableIdx = next.findIndex((b) => b.type === "table" && b.tableItems);
      if (firstTableIdx !== -1) {
        next[firstTableIdx] = { ...next[firstTableIdx], somaTotalLabel: label };
      }
      pushHistory(next);
      return next;
    });
  };

  // ── OCR ──────────────────────────────────────────────
  const handleOcrImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await runOcrOnFile(file);
  };

  const openOcrNativeCamera = async () => {
    const file = await takeNativePhoto("camera");
    if (file) await runOcrOnFile(file);
  };

  const runOcrOnFile = async (file: File) => {
    setShowOcrModal(false);
    setOcrLoading(true);
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("por");
      const { data: { text } } = await worker.recognize(file);
      await worker.terminate();
      if (text.trim()) {
        const idx = focusedBlockRef.current;
        setBlocks((prev) => {
          const next = [...prev];
          if (next[idx]?.type === "text") {
            next[idx] = { ...next[idx], content: (next[idx].content || "") + text.trim() };
          } else {
            next.splice(idx + 1, 0, { type: "text", content: text.trim() });
          }
          return next;
        });
        toast({ title: "Texto extraído e inserido!", description: `${text.trim().split(/\s+/).length} palavras extraídas.` });
      } else {
        toast({ title: "Nenhum texto encontrado", description: "Não foi possível extrair texto desta imagem." });
      }
    } catch {
      toast({ title: "Erro no OCR", description: "Não foi possível processar a imagem." });
    } finally {
      setOcrLoading(false);
    }
  };

  const handleCopy = () => {
    const text = `${title}\n\n${blocksToPlainText(blocks)}`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: "Nota copiada com sucesso!", description: "Conteúdo copiado para a área de transferência." });
    setTimeout(() => setCopied(false), 2000);
  };

  // ── QR/Barcode Scanner (BarcodeDetector nativo + ZXing fallback) ──
  const qrVideoRef = useRef<HTMLVideoElement>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const qrStreamRef = useRef<MediaStream | null>(null);
  const qrRafRef = useRef<number>(0);
  const qrDetectorRef = useRef<any>(null);

  const handleStartQrScanner = async () => {
    setShowQrScanner(true);
    setQrLoading(true);
  };

  useEffect(() => {
    if (showQrScanner) {
      iniciarQrStream();
    }
    return () => {
      qrStreamRef.current?.getTracks().forEach(t => t.stop());
      cancelAnimationFrame(qrRafRef.current);
      qrDetectorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showQrScanner]);

  const handleStopQrScanner = () => {
    qrStreamRef.current?.getTracks().forEach(t => t.stop());
    cancelAnimationFrame(qrRafRef.current);
    qrDetectorRef.current = null;
    setShowQrScanner(false);
    setQrLoading(false);
  };

  const handleQrFound = (decodedText: string) => {
    qrStreamRef.current?.getTracks().forEach(t => t.stop());
    cancelAnimationFrame(qrRafRef.current);
    const idx = focusedBlockRef.current;
    setBlocks((prev) => {
      const next = [...prev];
      if (next[idx]?.type === "text") {
        next[idx] = { ...next[idx], content: (next[idx].content || "") + decodedText };
      } else {
        next.splice(idx + 1, 0, { type: "text", content: decodedText });
      }
      return next;
    });
    toast({ title: "✅ Código lido!", description: decodedText.length > 60 ? decodedText.slice(0, 60) + "…" : decodedText });
    setShowQrScanner(false);
    setQrLoading(false);
  };

  const iniciarQrStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } } });
      qrStreamRef.current = stream;
      if (qrVideoRef.current) { qrVideoRef.current.srcObject = stream; await qrVideoRef.current.play(); }
    } catch {
      toast({ title: "Erro ao abrir câmera", description: "Verifique as permissões." });
      setShowQrScanner(false); setQrLoading(false); return;
    }

    const scanLoop = async () => {
      if (!qrVideoRef.current || !qrCanvasRef.current || !qrDetectorRef.current) return;
      const video = qrVideoRef.current; const canvas = qrCanvasRef.current;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0);
        try {
          const codes = await qrDetectorRef.current.detect(canvas);
          if (codes.length > 0) { handleQrFound(codes[0].rawValue); return; }
        } catch {}
      }
      qrRafRef.current = requestAnimationFrame(scanLoop);
    };

    const scanLoopZXing = () => {
      if (!qrVideoRef.current || !qrCanvasRef.current || !qrDetectorRef.current) return;
      const video = qrVideoRef.current; const canvas = qrCanvasRef.current;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0);
        try {
          const ZXing = (window as any).ZXing;
          const imgData = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
          const luminance = new ZXing.RGBLuminanceSource(imgData.data, canvas.width, canvas.height);
          const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(luminance));
          const result = qrDetectorRef.current.decodeBitmap(bitmap);
          if (result) { handleQrFound(result.getText()); return; }
        } catch {}
      }
      qrRafRef.current = requestAnimationFrame(scanLoopZXing);
    };

    if ("BarcodeDetector" in window) {
      qrDetectorRef.current = new (window as any).BarcodeDetector({ formats: ["code_128","code_39","ean_13","ean_8","qr_code","data_matrix","itf","upc_a","upc_e","pdf417","aztec"] });
      setQrLoading(false);
      scanLoop();
    } else {
      if ((window as any).ZXing) {
        const ZXing = (window as any).ZXing;
        const hints = new Map(); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        qrDetectorRef.current = new ZXing.BrowserMultiFormatReader(hints);
        setQrLoading(false); scanLoopZXing();
      } else {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.0/umd/index.min.js";
        script.onload = () => {
          const ZXing = (window as any).ZXing;
          const hints = new Map(); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
          qrDetectorRef.current = new ZXing.BrowserMultiFormatReader(hints);
          setQrLoading(false); scanLoopZXing();
        };
        script.onerror = () => { toast({ title: "Erro ao carregar leitor" }); setShowQrScanner(false); setQrLoading(false); };
        document.head.appendChild(script);
      }
    }
  };

  // ── Edit mode helpers ─────────────────────────────────
  const enterEditMode = useCallback(() => {
    // Save scroll position before switching to edit mode
    if (scrollContainerRef.current) {
      savedScrollRef.current = scrollContainerRef.current.scrollTop;
      justEnteredEditRef.current = true;
    }
    snapshotRef.current = { title, blocks: JSON.parse(JSON.stringify(blocks)), color: selectedColor };
    onSetReadOnly?.(false);
  }, [title, blocks, selectedColor, onSetReadOnly]);

  const focusEditorField = useCallback((target: "title" | "content", blockIndex = 0) => {
    pendingFocusRef.current = target;
    activeFieldRef.current = target;
    focusedBlockRef.current = blockIndex;
  }, []);

  // Calcula os retângulos (um por linha) do texto selecionado no editor, para desenhar o contorno.
  useEffect(() => {
    const clear = () => {
      if (selRectsKeyRef.current !== "") {
        selRectsKeyRef.current = "";
        setSelRects([]);
      }
    };
    if (!open || readOnly) { clear(); return; }
    let raf = 0;
    const compute = () => {
      raf = 0;
      try {
        const host = selHostRef.current;
        const sel = window.getSelection();
        if (!host || !sel || sel.rangeCount === 0 || sel.isCollapsed) { clear(); return; }
        const range = sel.getRangeAt(0);
        const anc = range.commonAncestorContainer;
        const ancEl = anc.nodeType === 1 ? (anc as Element) : anc.parentElement;
        if (!ancEl || !host.contains(ancEl) || !ancEl.closest(".rich-text-editable")) { clear(); return; }

        // só os retângulos do TEXTO selecionado (ignora caixas de blocos inteiros)
        const textNodes: Text[] = [];
        if (anc.nodeType === 3) {
          textNodes.push(anc as Text);
        } else {
          const walker = document.createTreeWalker(anc, NodeFilter.SHOW_TEXT);
          let n: Node | null = walker.nextNode();
          while (n && textNodes.length < 400) {
            if (range.intersectsNode(n)) textNodes.push(n as Text);
            n = walker.nextNode();
          }
        }
        const rects: DOMRect[] = [];
        for (const tn of textNodes) {
          const start = tn === range.startContainer ? range.startOffset : 0;
          const end = tn === range.endContainer ? range.endOffset : tn.length;
          if (end <= start) continue;
          const rr = document.createRange();
          rr.setStart(tn, start);
          rr.setEnd(tn, end);
          for (const r of Array.from(rr.getClientRects())) {
            if (r.width > 1 && r.height > 1) rects.push(r);
          }
        }
        if (rects.length === 0) { clear(); return; }

        // junta os pedaços da mesma linha em um retângulo só
        const lines: Array<{ l: number; t: number; r: number; b: number }> = [];
        for (const r of rects) {
          const line = lines.find((x) => Math.min(x.b, r.bottom) - Math.max(x.t, r.top) > Math.min(x.b - x.t, r.height) * 0.5);
          if (line) {
            line.l = Math.min(line.l, r.left);
            line.r = Math.max(line.r, r.right);
            line.t = Math.min(line.t, r.top);
            line.b = Math.max(line.b, r.bottom);
          } else {
            lines.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
          }
        }
        const hr = host.getBoundingClientRect();
        const next = lines.map((x) => ({
          l: Math.round(x.l - hr.left),
          t: Math.round(x.t - hr.top),
          w: Math.round(x.r - x.l),
          h: Math.round(x.b - x.t),
        }));
        const key = JSON.stringify(next);
        if (key !== selRectsKeyRef.current) {
          selRectsKeyRef.current = key;
          setSelRects(next);
        }
      } catch {
        clear();
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open, readOnly, blocks, editorFontSize, showFormatBar]);

  const activateFieldForEditing = useCallback((target: "title" | "content", blockIndex = 0) => {
    focusEditorField(target, blockIndex);
    if (readOnly && editingNote) enterEditMode();
  }, [editingNote, enterEditMode, focusEditorField, readOnly]);

  useEffect(() => {
    if (!open || readOnly || !pendingFocusRef.current) return;
    // Fallback: if ref callback didn't handle focus, try here
    const timer = setTimeout(() => {
      if (!pendingFocusRef.current) return; // already handled by ref callback
      const target = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (target === "title") {
        const el = titleInputRef.current;
        if (!el) return;
        el.focus({ preventScroll: true });
        const pos = pendingCursorRef.current ?? el.value.length;
        pendingCursorRef.current = null;
        const safePos = Math.min(pos, el.value.length);
        el.setSelectionRange(safePos, safePos);
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      const el = richTextRefs.current[focusedBlockRef.current];
      if (!el) return;
      el.focus({ preventScroll: true });
      const pos = pendingCursorRef.current ?? (el.innerText || "").length;
      pendingCursorRef.current = null;
      placeCaretAt(el, pos);
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 150);
    return () => clearTimeout(timer);
  }, [open, readOnly]);

  const hasUnsavedChanges = useCallback(() => {
    if (!snapshotRef.current) return false;
    return (
      title !== snapshotRef.current.title ||
      selectedColor !== snapshotRef.current.color ||
      JSON.stringify(blocks) !== JSON.stringify(snapshotRef.current.blocks)
    );
  }, [title, blocks, selectedColor]);

  const cancelEdit = useCallback(() => {
    if (snapshotRef.current) {
      setTitle(snapshotRef.current.title);
      setBlocks(JSON.parse(JSON.stringify(snapshotRef.current.blocks)));
      setSelectedColor(snapshotRef.current.color);
      snapshotRef.current = null;
    }
    onSetReadOnly?.(true);
  }, [onSetReadOnly]);

  // ── Save handlers ────────────────────────────────────
  const doSave = (status: "rascunho" | "publicada") => {
    if (status === "publicada" && !title.trim() && !blocksToPlainText(blocks).trim()) return;
    const serialized = serializeBlocks(blocks);
    const imageUrls: string[] = []; // as fotos já ficam dentro do texto da nota (serialized); gravar a lista separada duplicava tudo
    onSave(title, serialized, imageUrls, selectedColor, "default", "medium", status);
    markSaved(serialized);
    clearDraft();
    snapshotRef.current = null;
    onSetReadOnly?.(true);
    if (status === "rascunho") {
      toast({ title: "Rascunho salvo ✓" });
    } else {
      toast({ title: editingNote ? "Nota salva ✓" : "Nota criada ✓" });
    }
  };

  const doSaveAndClose = (status: "rascunho" | "publicada") => {
    if (status === "publicada" && !title.trim() && !blocksToPlainText(blocks).trim()) return;
    const serialized = serializeBlocks(blocks);
    const imageUrls: string[] = []; // as fotos já ficam dentro do texto da nota (serialized); gravar a lista separada duplicava tudo
    onSave(title, serialized, imageUrls, selectedColor, "default", "medium", status);
    clearDraft();
    snapshotRef.current = null;
    onOpenChange(false);
    if (status === "rascunho") {
      toast({ title: "Rascunho salvo ✓" });
    } else {
      toast({ title: editingNote ? "Nota salva ✓" : "Nota criada ✓" });
    }
  };

  const handleSaveDraft = () => doSaveAndClose("rascunho");
  const handleSavePublish = () => {
    if (editingNote && readOnly) {
      // In view mode, save just returns to view
      doSave("publicada");
    } else {
      doSaveAndClose("publicada");
    }
  };
  
  const handleSaveAndBackToView = () => {
    doSave("publicada");
  };

  // Close handler with unsaved changes check
  const handleClose = () => {
    try {
      if (isListening) toggleVoice();
    } catch {
      // nunca deixa um erro no microfone travar o botão de fechar
    }

    if (!readOnly && editingNote && hasUnsavedChanges()) {
      setShowUnsavedPrompt(true);
      return;
    }

    // Corrigido: garante que a foto ampliada/editor de desenho nunca fiquem
    // "presos" abertos e apareçam sozinhos na próxima nota.
    setViewingImage(null);
    setViewZoom(1);
    setViewTx(0);
    setViewTy(0);
    setViewRotation(0);
    setEditingImageIdx(null);

    // A tela fecha JÁ, na hora, sempre — independente de internet ou de
    // qualquer coisa que dê errado ao salvar. O salvamento roda depois,
    // blindado, e nunca prende o botão (isso resolvia um travamento
    // reportado apenas no app instalado no celular, só quando offline).
    onOpenChange(false);

    const hasContent = title.trim() || blocksToPlainText(blocks).trim();
    if (hasContent && !readOnly) {
      try {
        const serialized = serializeBlocks(blocks);
        const imageUrls: string[] = []; // as fotos já ficam dentro do texto da nota (serialized); gravar a lista separada duplicava tudo
        const status = editingNote?.status || "rascunho";
        if (!shouldSkipSave(serialized, false)) {
          onSave(title, serialized, imageUrls, selectedColor, "default", "medium", status);
        }

        if (!navigator.onLine) {
          toast({ title: "Salvo localmente", description: "Sincronizando quando houver conexão..." });
        }
      } catch {
        toast({ title: "Não foi possível salvar", description: "Tente abrir a nota de novo para editar." });
      }
    }

    clearDraft();
    snapshotRef.current = null;
  };

  // Liga o NoteEditor ao botão/gesto de voltar nativo do Android — sem isso,
  // voltar no celular não fechava a nota (não tinha ligação nenhuma com ela).
  // Usa uma ref pra sempre chamar a versão mais recente do handleClose, sem
  // ficar re-registrando (e empilhando histórico) a cada re-render.
  const handleCloseRef = useRef(handleClose);
  useEffect(() => {
    handleCloseRef.current = handleClose;
  });
  useEffect(() => {
    if (!open) return;
    const w = window as any;
    if (typeof w.__registerModal === "function") {
      w.__registerModal("note-editor", () => handleCloseRef.current());
    }
    return () => {
      if (typeof w.__unregisterModal === "function") {
        w.__unregisterModal();
      }
    };
  }, [open]);

  const plainText = blocksToPlainText(blocks);
  const wordCount = plainText.trim().split(/\s+/).filter(Boolean).length;
  const charCount = plainText.length;

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx < history.length - 1;

  // Botões do visualizador de foto: sempre com fundo escuro, para a letra/ícone branco
  // aparecer bem mesmo por cima de uma foto clara.
  const viewerPillBg = "rgba(0,0,0,0.72)";
  const viewerIconBtn: React.CSSProperties = {
    color: "#FFF",
    background: viewerPillBg,
    border: "none",
    width: viewerLandscape ? 34 : 40,
    height: viewerLandscape ? 34 : 40,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 1px 4px rgba(0,0,0,0.45)",
  };
  const viewerZoomControls = (
    <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => zoomBy(-0.5)} style={{ padding: 8, borderRadius: 8, background: viewerPillBg, color: "#FFF", border: "none", boxShadow: "0 1px 4px rgba(0,0,0,0.45)" }}>
        <ZoomOut size={18} />
      </button>
      <span style={{ color: "#FFF", fontSize: 13, minWidth: 52, textAlign: "center", background: viewerPillBg, borderRadius: 999, padding: "6px 10px", boxShadow: "0 1px 4px rgba(0,0,0,0.45)" }}>{Math.round(viewZoom * 100)}%</span>
      <button onClick={() => zoomBy(0.5)} style={{ padding: 8, borderRadius: 8, background: viewerPillBg, color: "#FFF", border: "none", boxShadow: "0 1px 4px rgba(0,0,0,0.45)" }}>
        <ZoomIn size={18} />
      </button>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(v); }} modal={false}>
      <DialogContent className="!flex !flex-col !fixed !inset-0 !left-0 !top-0 !translate-x-0 !translate-y-0 !w-screen !max-w-none !max-h-none !rounded-none !shadow-none !border-0 !p-0 !gap-0 !bg-transparent z-50 sm:!inset-auto sm:!left-1/2 sm:!top-1/2 sm:!-translate-x-1/2 sm:!-translate-y-1/2 sm:!w-full sm:!max-w-[480px] sm:!h-[92vh] sm:!max-h-[92vh] sm:!rounded-2xl sm:!shadow-2xl sm:!overflow-hidden"
        style={{ height: "100dvh", overflow: "hidden" }}
        aria-describedby={undefined}
        data-note-dark={isDark ? "true" : "false"}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Editor de Nota</DialogTitle>
        <style>{`.rich-text-editable[data-empty="true"]:before { content: attr(data-placeholder); color: ${placeholderColor}; pointer-events: none; } .rich-text-editable::selection, .rich-text-editable ::selection { background-color: transparent; } [data-note-dark="true"] .rich-text-editable [style*="26, 26, 46"], [data-note-dark="true"] .rich-text-editable [style*="#1a1a2e" i], [data-note-dark="true"] .note-rich-view [style*="26, 26, 46"], [data-note-dark="true"] .note-rich-view [style*="#1a1a2e" i] { color: ${textColor} !important; } ${DARK_TEXT_COLOR_CSS} @keyframes nbCaret{0%,49%{opacity:1}50%,100%{opacity:0}}`}</style>
        {/* ── NOTEPAD CONTAINER ── */}
        <div
          className="flex flex-col"
          style={{
            height: "100%",
            background: theme.bg,
            transition: "background 0.3s ease",
          }}
        >

          {/* ── EDIT MODE INDICATOR BAR ── */}
          {!readOnly && editingNote && (
            <div className="flex items-center justify-center gap-2 px-3 shrink-0" style={{ background: "#2D9E7F", transition: "background 0.3s ease", height: "max(env(safe-area-inset-top), 22px)" }}>
              <Pencil size={11} style={{ color: "#FFF" }} />
              <span className="text-[12px] font-bold text-white">Editando...</span>
            </div>
          )}

          {/* ── HEADER (2 linhas em mobile p/ garantir todos os botões visíveis) ── */}
          <div
            className="shrink-0"
            style={{ background: theme.headerBg, transition: "background 0.3s ease", paddingTop: !readOnly && editingNote ? 2 : "calc(8px + env(safe-area-inset-top))" }}
          >
            {/* Linha 1: voltar + título + fechar */}
            <div className="flex items-center gap-1 px-2 pb-1">
              {/* Antes havia aqui uma seta "Voltar" que fazia exatamente a
                  mesma coisa que o "X Fechar" à direita — duas setas pra uma
                  única ação. No lugar dela, o Desfazer agora fica sempre à
                  vista, sem precisar abrir o "•••". */}
              {!readOnly && (
                <button
                  onClick={undo}
                  disabled={!canUndo}
                  className="p-2 rounded-lg hover:bg-black/10 transition-colors shrink-0 disabled:opacity-30"
                  title="Desfazer"
                  aria-label="Desfazer"
                >
                  <Undo2 size={24} style={{ color: textColor }} />
                </button>
              )}

              {readOnly ? (
                <div
                  onClick={() => { if (editingNote) activateFieldForEditing("title"); }}
                  className="flex-1 min-w-0 bg-white/90 rounded-lg px-3 py-2 text-base font-semibold outline-none shadow-sm cursor-text select-text"
                  style={{ color: title ? "#1A1A2E" : "#9CA3AF", fontSize: "16px", minHeight: "38px", display: "flex", alignItems: "center", WebkitUserSelect: "text" }}
                >
                  {title || "Título da nota..."}
                </div>
              ) : (
                <input
                  ref={(el) => {
                    (titleInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
                    if (el && pendingFocusRef.current === "title") {
                      pendingFocusRef.current = null;
                      requestAnimationFrame(() => {
                        el.focus({ preventScroll: true });
                        const len = el.value.length;
                        el.setSelectionRange(len, len);
                      });
                    }
                  }}
                  value={title}
                  onChange={(e) => updateTitle(e.target.value)}
                  onFocus={() => { activeFieldRef.current = "title"; }}
                  onPaste={handleMobilePaste}
                  placeholder="Título da nota..."
                  className="flex-1 min-w-0 bg-white/90 rounded-lg px-3 py-1.5 text-base font-semibold placeholder:text-gray-400 outline-none border-0 shadow-sm"
                  style={{ color: "#1A1A2E", fontSize: "16px" }}
                />
              )}

              <button
                onClick={() => setShowMoreMenu((v) => !v)}
                className="p-2 rounded-lg hover:bg-black/10 transition-colors shrink-0"
                style={{ background: showMoreMenu ? "rgba(0,0,0,0.08)" : "transparent" }}
                title="Mais opções"
                aria-label="Mais opções"
              >
                <MoreHorizontal size={24} style={{ color: textColor }} />
              </button>

              <button
                onClick={handleClose}
                className="p-2 rounded-lg hover:bg-black/10 transition-colors shrink-0"
                title="Fechar aplicativo"
                aria-label="Fechar aplicativo"
              >
                <X size={26} style={{ color: textColor }} />
              </button>
            </div>

            {/* Linha 2: ações (cor, cadeado/copiar/compartilhar/editar) — escondida
                atrás do botão "•••", só aparece quando showMoreMenu é true */}
            {showMoreMenu && (
            <div className="flex items-center gap-1 px-2 pb-1.5 overflow-x-auto no-scrollbar" style={{ WebkitOverflowScrolling: "touch" }}>
              {/* Cor da nota — sempre visível em modo edição */}
              {!readOnly && (
                <button
                  onClick={() => setShowColorPicker(!showColorPicker)}
                  className="rounded-md border-2 border-white/60 shadow-sm shrink-0 transition-transform hover:scale-110 flex items-center justify-center"
                  style={{ background: NOTE_COLORS.find((c) => c.value === selectedColor)?.dot || "#FEF9C3", width: 44, height: 44 }}
                  title="Cor da nota"
                  aria-label="Cor da nota"
                />
              )}

              {/* Desfazer removido daqui — agora fica sempre visível na
                  linha 1 do cabeçalho, sem precisar abrir esse menu. */}

              {/* Excluir — só aparece editando uma nota que já existe (uma
                  nota nova, ainda não salva, não tem o que excluir) */}
              {editingNote && onDelete && (
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  className="p-2 rounded-lg hover:bg-black/10 transition-colors shrink-0 flex items-center justify-center"
                  title="Excluir nota"
                  aria-label="Excluir nota"
                  style={{ color: "#E53935", minWidth: 44, minHeight: 44 }}
                >
                  <Trash2 size={22} />
                </button>
              )}

              {/* Copiar — sempre visível */}
              <button
                onClick={handleCopy}
                className="p-2 rounded-lg hover:bg-black/10 transition-colors shrink-0 flex items-center justify-center"
                title="Copiar nota"
                aria-label="Copiar nota"
                style={{ color: textColor, minWidth: 44, minHeight: 44 }}
              >
                {copied ? <Check size={22} className="text-green-700" /> : <Copy size={22} />}
              </button>

              {/* Toggle modo escuro */}
              <button
                onClick={() => setSelectedColor(selectedColor === "bg-gray-800" ? lastLightColorRef.current : "bg-gray-800")}
                className="p-2 rounded-full hover:bg-black/10 transition-all shrink-0 flex items-center justify-center"
                title={selectedColor === "bg-gray-800" ? "Modo claro" : "Modo escuro"}
                aria-label={selectedColor === "bg-gray-800" ? "Modo claro" : "Modo escuro"}
                style={{
                  background: selectedColor === "bg-gray-800" ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)",
                  width: 42, height: 42, minWidth: 42,
                  color: textColor,
                }}
              >
                {selectedColor === "bg-gray-800" ? (
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                ) : (
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                )}
              </button>

              {/* Compartilhar — sempre visível */}
              {editingNote && (
                <button
                  onClick={() => setShowShareModal(true)}
                  className="p-2 rounded-lg hover:bg-black/10 transition-all shrink-0 flex items-center justify-center"
                  title="Compartilhar nota"
                  aria-label="Compartilhar nota"
                  style={{ color: textColor, minWidth: 44, minHeight: 44 }}
                >
                  <Share2 size={22} />
                </button>
              )}

              {/* Editar — em modo visualização */}
              {readOnly && editingNote && (
                <button
                  onClick={enterEditMode}
                  className="px-3 py-2 rounded-lg hover:bg-black/10 transition-all shrink-0 flex items-center gap-1 font-semibold"
                  title="Editar nota"
                  aria-label="Editar nota"
                  style={{ color: textColor, fontSize: 15 }}
                >
                  <Pencil size={20} /> Editar
                </button>
              )}

              {/* Fechar o menu ••• — fica sempre na ponta direita da linha */}
              <button
                onClick={() => { setShowMoreMenu(false); setShowColorPicker(false); }}
                className="p-2 rounded-lg hover:bg-black/10 transition-colors shrink-0 flex items-center justify-center ml-auto"
                style={{ color: textColor, minWidth: 44, minHeight: 44, position: "sticky", right: 0, background: theme.headerBg }}
                title="Fechar menu"
                aria-label="Fechar menu"
              >
                <X size={24} />
              </button>
            </div>
            )}
          </div>

          {/* Color picker dropdown */}
          {showColorPicker && (
            <div
              className="flex gap-2 flex-wrap px-3 py-3 shrink-0"
              style={{ background: theme.headerBg, transition: "background 0.3s ease", WebkitOverflowScrolling: "touch" }}
            >
              {NOTE_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => { setSelectedColor(c.value); setShowColorPicker(false); }}
                  className={cn(
                    "rounded-full border-2 transition-all duration-200 shrink-0",
                    selectedColor === c.value
                      ? "border-gray-800 scale-110 shadow-md"
                      : "border-white/60 hover:scale-105"
                  )}
                  style={{ background: c.dot, width: 44, height: 44, minWidth: 44, minHeight: 44 }}
                  title={c.label}
                  aria-label={c.label}
                />
              ))}
            </div>
          )}

          {/* ── Sub-header — escondido atrás do "•••" ── */}
          {showMoreMenu && (
          <div className="flex items-center justify-between gap-2 flex-wrap px-4 py-1.5 text-[13px] shrink-0" style={{ color: theme.textMuted, transition: "color 0.3s ease" }}>
            <span className="font-medium">
              {readOnly ? "👁️ Visualização" : (editingNote ? "✏️ Editando" : "Nova nota")}
              {isListening && (
                <span className="ml-2 text-red-500 font-semibold animate-pulse">
                  🎤 {activeFieldRef.current === "title" ? "Ditando no título" : "Ditando no conteúdo"}
                </span>
              )}
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {[14, 16, 20, 24, 30].map((size, i) => (
                <button
                  key={size}
                  onClick={() => changeEditorFontSize(size)}
                  style={{
                    width: 34, height: 34,
                    borderRadius: 8,
                    background: editorFontSize === size ? theme.borderAccent : "transparent",
                    border: `0.5px solid ${editorFontSize === size ? theme.borderAccent : theme.lines}`,
                    fontSize: 11 + i * 3,
                    fontWeight: 700,
                    color: editorFontSize === size ? isDark ? "#1A1A2E" : "#fff" : theme.textMuted,
                    cursor: "pointer",
                    lineHeight: 1,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}
                >
                  A
                </button>
              ))}

              <button
                onClick={toggleHighContrast}
                title="Alto contraste"
                style={{
                  width: 34, height: 34, borderRadius: 8, marginLeft: 4, flexShrink: 0,
                  background: highContrast ? theme.borderAccent : "transparent",
                  border: `0.5px solid ${theme.lines}`,
                  color: highContrast ? (isDark ? "#1A1A2E" : "#fff") : theme.textMuted,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <Contrast size={19} />
              </button>

              <button
                onClick={toggleReadAloud}
                title="Ouvir a nota em voz alta"
                style={{
                  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                  background: isSpeaking ? theme.borderAccent : "transparent",
                  border: `0.5px solid ${theme.lines}`,
                  color: isSpeaking ? (isDark ? "#1A1A2E" : "#fff") : theme.textMuted,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {isSpeaking ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>

              <button
                onClick={() => setReadingMode(true)}
                title="Modo de leitura simplificado"
                style={{
                  width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                  background: "transparent",
                  border: `0.5px solid ${theme.lines}`,
                  color: theme.textMuted,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <BookOpen size={19} />
              </button>
            </div>
          </div>
          )}

          {/* ── LINED PAPER BODY ── */}
          <div
            ref={scrollContainerRef}
            className="flex-1 min-h-0 overflow-y-auto px-4"
            style={{
              background: `repeating-linear-gradient(to bottom, transparent, transparent 31px, ${theme.lines} 32px)`,
              backgroundPosition: "0 0",
              transition: "background 0.3s ease",
              minHeight: "120px",
              touchAction: "pan-y",
              WebkitOverflowScrolling: "touch",
              overscrollBehavior: "contain",
            }}
          >
            <div className="py-2" ref={selHostRef} style={{ position: "relative" }}>
              {!readOnly && selRects.map((r, i) => (
                <div
                  key={i}
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: r.l - 2,
                    top: r.t - 1,
                    width: r.w + 4,
                    height: r.h + 2,
                    border: `2px solid ${selectionOutline}`,
                    borderRadius: 6,
                    pointerEvents: "none",
                    zIndex: 1,
                  }}
                />
              ))}
              {blocks.map((block, idx) => {
                if (block.type === "text") {
                  if (readOnly) {
                    // Bloco de texto totalmente vazio (sobra de quando a tabela foi inserida): no modo leitura não ocupa linha
                    if (!block.content && !consistentHtml(block) && blocks.length > 1) return null;
                    return (
                      <div
                        key={`text-${idx}`}
                        onClick={(e) => {
                          if (!editingNote) return;
                          // Capture tap position to place cursor there
                          let cursorPos = (block.content || "").length;
                          try {
                            if ((document as any).caretPositionFromPoint) {
                              const pos = (document as any).caretPositionFromPoint(e.clientX, e.clientY);
                              if (pos?.offset != null) cursorPos = pos.offset;
                            } else if ((document as any).caretRangeFromPoint) {
                              const range = (document as any).caretRangeFromPoint(e.clientX, e.clientY);
                              if (range?.startOffset != null) cursorPos = range.startOffset;
                            }
                          } catch {}
                          pendingCursorRef.current = cursorPos;
                          activateFieldForEditing("content", idx);
                        }}
                        className="w-full bg-transparent text-base select-text"
                        style={{
                          lineHeight: `${editorFontSize * 2}px`,
                          minHeight: `${editorFontSize * 2}px`,
                          fontSize: `${editorFontSize}px`,
                          color: block.style?.color || (block.content ? textColor : placeholderColor),
                          fontFamily: FONT_OPTIONS[block.style?.font || "default"].family,
                          fontWeight: block.style?.bold ? 700 : 400,
                          textAlign: block.style?.align || "left",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          cursor: "text",
                          userSelect: "text",
                          WebkitUserSelect: "text",
                        }}
                      >
                        {consistentHtml(block) ? (
                          <span className="note-rich-view" dangerouslySetInnerHTML={{ __html: linkifyHtml(sanitizeRichHtml(consistentHtml(block)!)) }} />
                        ) : block.content ? (
                          renderTextWithLinks(block.content, block.style?.color || textColor, editorFontSize)
                        ) : (
                          idx === 0 && blocks.length === 1 ? "Comece a escrever sua nota..." : ""
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={`text-${idx}`}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={() => updateTextBlockRich(idx)}
                      onCompositionStart={() => { isComposingRef.current[idx] = true; }}
                      onCompositionEnd={() => {
                        isComposingRef.current[idx] = false;
                        updateTextBlockRich(idx);
                      }}
                      onBlur={() => {
                        isFocusedRef.current[idx] = false;
                        const el = richTextRefs.current[idx];
                        if (!el) return;
                        const linked = linkifyHtml(el.innerHTML);
                        if (linked !== el.innerHTML) {
                          el.innerHTML = linked;
                          updateTextBlockRich(idx);
                        }
                      }}
                      onFocus={() => {
                        isFocusedRef.current[idx] = true;
                        focusedBlockRef.current = idx;
                        activeFieldRef.current = "content";
                        setActiveBlockIdx(idx);
                      }}
                      onPaste={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const text = e.clipboardData.getData("text/plain");
                        if (!text) return;
                        // Inserção manual via Range API em vez de document.execCommand("insertText"):
                        // o execCommand é uma API antiga e, em alguns teclados Android (Gboard),
                        // o navegador dispara a inserção tanto pelo evento nativo quanto pelo
                        // execCommand, colando o texto duplicado. A inserção manual evita isso.
                        const sel = window.getSelection();
                        const el = richTextRefs.current[idx];
                        if (sel && sel.rangeCount > 0 && el) {
                          const range = sel.getRangeAt(0);
                          if (el.contains(range.commonAncestorContainer)) {
                            range.deleteContents();
                            const textNode = document.createTextNode(text);
                            range.insertNode(textNode);
                            range.setStartAfter(textNode);
                            range.setEndAfter(textNode);
                            range.collapse(true);
                            sel.removeAllRanges();
                            sel.addRange(range);
                            updateTextBlockRich(idx);
                            return;
                          }
                        }
                        // Fallback se não houver seleção válida dentro do bloco
                        document.execCommand("insertText", false, text);
                      }}
                      data-empty={!block.content && !block.contentHtml ? "true" : "false"}
                      data-placeholder={idx === 0 && blocks.length === 1 ? "Comece a escrever sua nota..." : ""}
                      className="w-full bg-transparent border-0 outline-none text-base rich-text-editable"
                      style={{
                        lineHeight: `${editorFontSize * 2}px`,
                        minHeight: `${editorFontSize * 2}px`,
                        fontSize: `${editorFontSize}px`,
                        color: textColor,
                        fontFamily: FONT_OPTIONS[block.style?.font || "default"].family,
                        textAlign: block.style?.align || "left",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                      ref={(el) => {
                        richTextRefs.current[idx] = el;
                        if (!el) return;
                        const desiredHtml = consistentHtml(block) ?? textToHtml(block.content || "");
                        // Só re-semeia se estiver fora de sincronia (edição externa: desfazer,
                        // dividir bloco, carregar nota) — nunca enquanto a pessoa está digitando,
                        // pra não fazer o cursor pular de lugar.
                        if (el.innerHTML !== desiredHtml && document.activeElement !== el && !isFocusedRef.current[idx] && !isComposingRef.current[idx]) {
                          el.innerHTML = desiredHtml;
                        }
                        // Focus immediately when mounted if this is the pending focus block
                        if (pendingFocusRef.current === "content" && focusedBlockRef.current === idx) {
                          pendingFocusRef.current = null;
                          requestAnimationFrame(() => {
                            el.focus({ preventScroll: true });
                            const pos = pendingCursorRef.current ?? (el.innerText || "").length;
                            pendingCursorRef.current = null;
                            placeCaretAt(el, pos);
                            // Restore scroll position immediately
                            if (scrollContainerRef.current && savedScrollRef.current > 0) {
                              scrollContainerRef.current.scrollTop = savedScrollRef.current;
                            }
                          });
                        }
                      }}
                    />
                  );
                }

                if (block.type === "checklist" && block.items) {
                  const total = block.items.length;
                  const checked = block.items.filter((i) => i.checked).length;
                  const progress = total > 0 ? Math.round((checked / total) * 100) : 0;
                  const cFont = editorFontSize; // segue o mesmo ajuste A/A+/A++ do resto da nota
                  return (
                    <div key={`checklist-${idx}`} className="my-2 w-full max-w-full overflow-hidden">
                      {/* Progress bar */}
                      {total > 0 && (
                        <div className="flex items-center gap-2 mb-2 px-1">
                          <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: isDark ? "#444" : "#E0E0E0" }}>
                            <div
                              className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${progress}%`, background: progress === 100 ? "#4CAF50" : "#2D9E7F" }}
                            />
                          </div>
                          <span className="font-bold shrink-0" style={{ color: progress === 100 ? "#4CAF50" : theme.textMuted, fontSize: cFont * 0.7 }}>
                            {checked}/{total} {progress === 100 && "✓"}
                          </span>
                        </div>
                      )}
                      <div className="space-y-0.5">
                        {block.items.map((item, itemIdx) => (
                          <div
                            key={item.id}
                            className="flex items-center gap-2 group/check rounded-lg px-1 py-0.5 transition-colors"
                            style={{ background: item.checked ? (isDark ? "rgba(76,175,80,0.1)" : "rgba(76,175,80,0.05)") : "transparent" }}
                            draggable={!readOnly}
                            onDragStart={(e) => {
                              e.dataTransfer.setData("checklist-drag", JSON.stringify({ blockIdx: idx, itemIdx }));
                              e.dataTransfer.effectAllowed = "move";
                            }}
                            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                            onDrop={(e) => {
                              e.preventDefault();
                              try {
                                const data = JSON.parse(e.dataTransfer.getData("checklist-drag"));
                                if (data.blockIdx === idx && data.itemIdx !== itemIdx) {
                                  setBlocks((prev) => {
                                    const next = [...prev];
                                    const items = [...(next[idx].items || [])];
                                    const [moved] = items.splice(data.itemIdx, 1);
                                    items.splice(itemIdx, 0, moved);
                                    next[idx] = { ...next[idx], items };
                                    pushHistory(next);
                                    return next;
                                  });
                                }
                              } catch {}
                            }}
                          >
                            {/* Drag handle */}
                            {!readOnly && (
                              <span className="cursor-grab opacity-0 group-hover/check:opacity-40 transition-opacity select-none" style={{ color: theme.textMuted, fontSize: cFont * 0.8 }}>⠿</span>
                            )}
                            <button
                              onClick={() => updateChecklistItem(idx, item.id, { checked: !item.checked })}
                              className="shrink-0 transition-all duration-200"
                              style={{ color: item.checked ? "#4CAF50" : (isDark ? "#888" : "#BDBDBD") }}
                            >
                              {item.checked ? <CheckSquare size={cFont * 1.15} /> : <Square size={cFont * 1.15} />}
                            </button>
                            {readOnly ? (
                              <span
                                onPointerDown={(e) => {
                                  if (editingNote) {
                                    e.preventDefault();
                                    activateFieldForEditing("content", idx);
                                  }
                                }}
                                className="flex-1 min-w-0 break-words"
                                style={{
                                  lineHeight: `${cFont * 1.35}px`,
                                  fontSize: cFont,
                                  fontWeight: item.bold ? 700 : 400,
                                  color: item.checked ? "#999" : textColor,
                                  textDecoration: item.checked ? "line-through" : "none",
                                  opacity: item.checked ? 0.7 : 1,
                                }}
                              >
                                {item.text || "Item da lista..."}
                              </span>
                            ) : (
                            <textarea
                              ref={(el) => {
                                if (el) {
                                  el.style.height = "auto";
                                  el.style.height = `${el.scrollHeight}px`;
                                }
                              }}
                              value={item.text}
                              onChange={(e) => {
                                updateChecklistItem(idx, item.id, { text: e.target.value });
                                e.target.style.height = "auto";
                                e.target.style.height = `${e.target.scrollHeight}px`;
                              }}
                              onFocus={(e) => {
                                focusedBlockRef.current = idx;
                                activeFieldRef.current = "content";
                              }}
                              rows={1}
                              tabIndex={0}
                              onPaste={handleMobilePaste}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addChecklistItemAfter(idx);
                                }
                              }}
                              placeholder="Item da lista..."
                              className="flex-1 min-w-0 bg-transparent border-0 outline-none resize-none overflow-hidden"
                              style={{
                                lineHeight: `${cFont * 1.35}px`,
                                paddingTop: `${cFont * 0.32}px`,
                                paddingBottom: `${cFont * 0.32}px`,
                                fontSize: cFont,
                                fontFamily: "inherit",
                                fontWeight: item.bold ? 700 : 400,
                                color: item.checked ? "#999" : textColor,
                                textDecoration: item.checked ? "line-through" : "none",
                                opacity: item.checked ? 0.7 : 1,
                              }}
                            />
                            )}
                            {!readOnly && (
                              <button
                                onClick={() => updateChecklistItem(idx, item.id, { bold: !item.bold })}
                                className="shrink-0 transition-opacity p-1 rounded hover:bg-black/5"
                                style={{ color: item.bold ? "#2D9E7F" : "#BDBDBD" }}
                                title="Negrito"
                              >
                                <BoldIcon size={cFont * 0.85} />
                              </button>
                            )}
                            {!readOnly && (
                              <button
                                onClick={() => setPendingDeleteItem({ type: "checklist", blockIdx: idx, itemId: item.id, label: item.text || "esse item" })}
                                className="shrink-0 opacity-0 group-hover/check:opacity-100 transition-opacity p-1 rounded hover:bg-black/5"
                                style={{ color: "#BDBDBD" }}
                              >
                                <Trash2 size={Math.min(cFont * 0.78, 18)} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {!readOnly && (
                        <button
                          onClick={() => addChecklistItemAfter(idx)}
                          className="flex items-center gap-1 ml-7 py-1 hover:opacity-80 transition-opacity"
                          style={{ color: theme.textMuted, fontSize: cFont * 0.85 }}
                        >
                          + Adicionar item
                        </button>
                      )}
                    </div>
                  );
                }

                if (block.type === "table" && block.tableItems) {
                  const total = calcularTotalTabela(block.tableItems);
                  const tFont = editorFontSize; // tamanho base — segue o mesmo ajuste A/A+/A++ do resto da nota
                  return (
                    <div key={`table-${idx}`} className="my-2 w-full max-w-full overflow-hidden">
                      <div className="flex items-center gap-1.5 mb-2 px-1">
                        <Table2 size={Math.min(tFont, 22)} style={{ color: theme.textMuted, flexShrink: 0 }} />
                        {readOnly ? (
                          <span className="font-bold min-w-0 truncate" style={{ color: theme.textMuted, fontSize: tFont * 0.85 }}>
                            {block.tableTitle || "Tabela Manual"}
                          </span>
                        ) : (
                          <input
                            value={block.tableTitle ?? "Tabela Manual"}
                            onChange={(e) => updateTableTitle(idx, e.target.value)}
                            onFocus={(e) => { focusedBlockRef.current = idx; activeFieldRef.current = "content"; e.target.select(); }}
                            className="font-bold bg-transparent border-0 outline-none min-w-0 flex-1"
                            style={{ color: theme.textMuted, fontSize: tFont * 0.85 }}
                          />
                        )}
                      </div>
                      <div className="space-y-2 w-full max-w-full">
                        {(() => {
                          // Cartão por linha: ✓ redondo | nome (ocupa o espaço que sobra) | valor.
                          // Calculadora e lixeira ficam numa barra com texto, embaixo da linha tocada.
                          const checkSize = 26;
                          return block.tableItems.map((item) => {
                          const ehPct = tableValorEhPorcentagem(item.valor);
                          const numero = tableValorParaNumero(item.valor);
                          const calcAberta = calcRow?.blockIdx === idx && calcRow?.itemId === item.id;
                          const previaCalc = calcAberta && /[+\-−×÷*/]/.test(calcExpr.replace(/^\s*-/, "")) ? evaluateExpression(calcExpr) : null;
                          const historicoCalc = item.calc?.historico ?? [];
                          // Histórico da conta começa recolhido; o ícone ao lado do valor abre e fecha
                          const histMinimizado = calcMin[item.id] !== false;
                          // O ícone só aparece se houver mais de um valor na conta (a calculadora foi usada com uma soma/conta)
                          const temMultiplos =
                            historicoCalc.length > 1 ||
                            historicoCalc.some((h) => /[+−×÷*\/]/.test(h.expressao) || /\d\s*-\s*\d/.test(h.expressao));
                          // Calculadora e lixeira só aparecem na linha em edição
                          const ativa = !readOnly && (linhaAtivaId === item.id || calcAberta);
                          // Com a calculadora aberta (teclado do app) o valor da linha mostra o resultado ao vivo da conta
                          const vivo = calcAberta && tecladoProprio && calcAoVivo !== null;
                          const valorExibido = vivo ? formatarMoedaBRL(calcAoVivo as number) : valorParaExibir(item.valor, valorFocadoId === item.id);
                          // Texto "molde" que dá a largura do campo de valor: o mais longo entre o formatado e o digitado,
                          // para a calculadora não "pular" quando você toca no valor para editar.
                          const valorFormatado = valorParaExibir(item.valor || "", false);
                          const valorMolde = vivo || valorExibido.length > valorFormatado.length ? valorExibido : valorFormatado;
                          const numeroTela = vivo ? (calcAoVivo as number) : numero;
                          return (
                            <div
                              key={item.id}
                              id={`linha-${item.id}`}
                              onClick={() => { if (!readOnly) setLinhaAtivaId(item.id); }}
                              className="rounded-xl px-3 py-2.5 w-full"
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: readOnly ? 0 : 10,
                                background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.025)",
                                border: `1px solid ${!readOnly && (linhaAtivaId === item.id || calcAberta) ? "#2D9E7F" : theme.lines}`,
                                borderRadius: 14,
                                boxSizing: "border-box",
                                maxWidth: "100%",
                              }}
                            >
                              {/* Linha principal (flexbox): ✓ | nome (flex-1) | 🧮 + valor | 🗑 */}
                              <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0 }}>
                              <button
                                onClick={(e) => { e.stopPropagation(); if (!readOnly) updateTableItem(idx, item.id, { marcado: !item.marcado }); }}
                                disabled={readOnly}
                                aria-label={item.marcado ? "Desmarcar item" : "Marcar item"}
                                aria-pressed={item.marcado}
                                style={{
                                  width: checkSize, height: checkSize, borderRadius: "50%", flexShrink: 0,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  color: "#2D9E7F",
                                  background: item.marcado ? (isDark ? "rgba(76,175,80,0.22)" : "rgba(45,158,127,0.16)") : "transparent",
                                  border: item.marcado ? "1.5px solid transparent" : `1.5px solid ${isDark ? "#777" : "#BDBDBD"}`,
                                }}
                              >
                                {item.marcado && <Check size={16} strokeWidth={3} />}
                              </button>
                              <textarea
                                ref={(el) => {
                                  nomeRefs.current[item.id] = el;
                                  if (el) {
                                    el.style.height = "auto";
                                    el.style.height = `${el.scrollHeight}px`;
                                    // Linha recém-inserida: foco automático no Nome, com o cursor pronto para digitar
                                    if (novoItemFocoRef.current === item.id && !readOnly) {
                                      novoItemFocoRef.current = null;
                                      el.focus();
                                      try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignora */ }
                                    }
                                  }
                                }}
                                autoFocus={!readOnly && novoItemFocoRef.current === item.id}
                                enterKeyHint="next"
                                onKeyDown={(e) => {
                                  // Enter no Nome → vai para o Valor (Shift+Enter continua quebrando linha)
                                  if (readOnly || e.nativeEvent.isComposing) return;
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    valorRefs.current[item.id]?.focus();
                                  }
                                }}
                                value={item.nome}
                                onChange={(e) => {
                                  if (!readOnly) updateTableItem(idx, item.id, { nome: e.target.value });
                                  e.target.style.height = "auto";
                                  e.target.style.height = `${e.target.scrollHeight}px`;
                                }}
                                onFocus={() => {
                                  focusedBlockRef.current = idx; activeFieldRef.current = "content";
                                  // ao ir para o Nome com a calculadora aberta, lança a conta (se for válida) e fecha
                                  if (calcRow && tecladoProprio) sairCalcTabela();
                                  setLinhaAtivaId(item.id);
                                }}
                                onPaste={handleMobilePaste}
                                readOnly={readOnly}
                                rows={1}
                                tabIndex={readOnly ? -1 : 0}
                                placeholder="Nome"
                                className="bg-transparent border-0 outline-none font-medium resize-none overflow-hidden"
                                style={{ color: textColor, opacity: item.marcado ? 1 : 0.6, fontSize: tFont, lineHeight: `${tFont * 1.3}px`, fontFamily: "inherit", flex: "1 1 0%", minWidth: 0 }}
                              />
                              {/* Calculadora (colada à esquerda do valor, só na linha em edição) + valor + ícone de minimizar (à direita do valor) */}
                              <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0, flex: "0 1 auto", maxWidth: "64%" }}>
                              {ativa && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (calcAberta) sairCalcTabela();
                                    else { setLinhaAtivaId(item.id); abrirCalcTabela(idx, item); }
                                  }}
                                  aria-label={calcAberta ? "Salvar e fechar a calculadora" : "Abrir calculadora"}
                                  aria-expanded={calcAberta}
                                  style={{
                                    width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                                    color: calcAberta ? "#FFF" : theme.textMuted,
                                    background: calcAberta ? "#2D9E7F" : (isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)"),
                                  }}
                                >
                                  <Calculator size={18} />
                                </button>
                              )}
                              <div style={{ position: "relative", display: "grid", minWidth: 0, flex: "0 1 auto" }}>
                              <span
                                aria-hidden="true"
                                style={{
                                  gridArea: "1 / 1", visibility: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                                  fontSize: tFont, lineHeight: `${tFont * 1.3}px`, fontWeight: 600, fontFamily: "inherit",
                                  textAlign: "right", paddingRight: 4, minWidth: 24,
                                }}
                              >
                                {(valorMolde || "Valor") + "\u200b"}
                              </span>
                              <textarea
                                ref={(el) => { valorRefs.current[item.id] = el; }}
                                enterKeyHint="done"
                                onKeyDown={(e) => {
                                  // Enter no Valor → lança a linha e abre uma nova (foco no Nome)
                                  if (readOnly || e.nativeEvent.isComposing) return;
                                  if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    confirmarValorTabela(idx, item.id);
                                  }
                                }}
                                value={valorExibido}
                                onChange={(e) => {
                                  // Digitar o valor direto apaga a conta antiga (some o histórico e os botões)
                                  if (!readOnly) updateTableItem(idx, item.id, item.calc ? { valor: e.target.value, calc: undefined } : { valor: e.target.value });
                                }}
                                inputMode={tecladoProprio && !readOnly ? "none" : undefined}
                                onFocus={(e) => {
                                  focusedBlockRef.current = idx; activeFieldRef.current = "content";
                                  setLinhaAtivaId(item.id);
                                  // Teclado do app: tocar no valor abre a calculadora da linha (sem o teclado do celular)
                                  if (tecladoProprio && !readOnly) {
                                    if (calcRow?.itemId !== item.id) abrirCalcTabela(idx, item);
                                    return;
                                  }
                                  setValorFocadoId(item.id);
                                  const el = e.target;
                                  requestAnimationFrame(() => { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignora */ } });
                                }}
                                onBlur={() => setValorFocadoId((cur) => (cur === item.id ? null : cur))}
                                onPaste={handleMobilePaste}
                                readOnly={readOnly || tecladoProprio}
                                rows={1}
                                tabIndex={readOnly ? -1 : 0}
                                placeholder="Valor"
                                className="bg-transparent border-0 outline-none text-right font-semibold resize-none overflow-hidden"
                                style={{
                                  color: numeroTela < 0 ? "#E53935" : (isDark ? "#81C784" : "#2D9E7F"),
                                  opacity: item.marcado ? 1 : 0.6,
                                  fontSize: tFont,
                                  lineHeight: `${tFont * 1.3}px`,
                                  fontFamily: "inherit",
                                  // fica por cima do molde invisível: mesma largura e altura do texto
                                  position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
                                  margin: 0, padding: 0, paddingRight: 4, boxSizing: "border-box", display: "block",
                                  caretColor: "#2D9E7F",
                                  // com o teclado do app, quem recebe o toque é o botão transparente por cima (funciona no dedo e no mouse)
                                  pointerEvents: tecladoProprio && !readOnly ? "none" : "auto",
                                }}
                              />
                              {/* Botão transparente sobre o valor: toque abre a calculadora; novo toque salva e fecha */}
                              {!readOnly && tecladoProprio && (
                                <button
                                  type="button"
                                  aria-label={calcAberta ? "Salvar o valor e fechar a calculadora" : "Editar o valor"}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (calcAberta) sairCalcTabela();
                                    else { setLinhaAtivaId(item.id); abrirCalcTabela(idx, item); }
                                  }}
                                  style={{ position: "absolute", left: 0, right: 0, top: -6, bottom: -6, background: "transparent", zIndex: 1, touchAction: "manipulation" }}
                                />
                              )}
                              {/* Cursor piscando do lado direito do valor enquanto a calculadora da linha está aberta (ex.: 19,99|) */}
                              {!readOnly && tecladoProprio && calcAberta && (
                                <span
                                  aria-hidden="true"
                                  style={{
                                    position: "absolute", right: 0, top: "12%", bottom: "12%", width: 2, borderRadius: 1,
                                    background: "#2D9E7F", animation: "nbCaret 1s steps(1) infinite", pointerEvents: "none",
                                  }}
                                />
                              )}
                              </div>
                              {/* Minimizar/maximizar a conta: ícone bem pequeno à direita do valor, só se há mais de um valor na conta */}
                              {temMultiplos && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setCalcMin((prev) => ({ ...prev, [item.id]: prev[item.id] === false })); }}
                                  aria-label={histMinimizado ? "Maximizar a conta" : "Minimizar a conta"}
                                  aria-expanded={!histMinimizado}
                                  style={{ width: 22, height: 22, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: theme.textMuted }}
                                >
                                  {histMinimizado ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                                </button>
                              )}
                              </div>
                              {/* Lixeira: ponta direita da linha (só na linha em edição) */}
                              {ativa && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); setPendingDeleteItem({ type: "table", blockIdx: idx, itemId: item.id, label: item.nome || "esse item" }); }}
                                  aria-label="Remover item"
                                  style={{
                                    width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                                    color: "#E57373", background: isDark ? "rgba(229,115,115,0.14)" : "rgba(229,115,115,0.12)",
                                  }}
                                >
                                  <Trash2 size={17} />
                                </button>
                              )}
                              </div>

                              {/* Calculadora da linha: abre ao tocar no 🧮 e some ao confirmar (Enter ou ✓) */}
                              {!readOnly && calcAberta && (
                                <div
                                  style={{
                                    gridColumn: "1 / -1", display: "flex", flexDirection: "column", gap: 6,
                                    padding: 8, borderRadius: 10,
                                    background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)",
                                  }}
                                >
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <textarea
                                      ref={calcInputRef}
                                      rows={1}
                                      inputMode={tecladoProprio ? "none" : undefined}
                                      value={calcExpr}
                                      onChange={(e) => {
                                        calcCursorRef.current = null;
                                        const texto = e.target.value.replace(/\n/g, " ");
                                        // a vírgula automática só age quando você digita no fim da conta (não bagunça números do meio)
                                        const noFim = e.target.selectionStart === e.target.value.length;
                                        setCalcExpr(calcVirgulaAuto && noFim ? aplicarVirgulaAutomatica(texto) : texto);
                                        if (calcError) setCalcError(null);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") { e.preventDefault(); confirmarCalcTabela(); }
                                        else if (e.key === "Escape") { e.preventDefault(); fecharCalcTabela(); }
                                      }}
                                      onFocus={() => { focusedBlockRef.current = idx; activeFieldRef.current = "content"; }}
                                      placeholder={tecladoProprio ? "Digite o valor" : (calcVirgulaAuto ? "399 + 832" : "3.99 + 8.32 + 25.78")}
                                      autoComplete="off"
                                      autoCapitalize="off"
                                      spellCheck={false}
                                      enterKeyHint="done"
                                      aria-label="Conta"
                                      style={{
                                        flex: 1, minWidth: 0, fontSize: tFont, color: textColor, background: "transparent",
                                        border: `1px solid ${theme.lines}`, borderRadius: 8, padding: "6px 8px", outline: "none",
                                        caretColor: "#2D9E7F",
                                        // quebra de linha automática: a conta inteira fica visível
                                        resize: "none", overflow: "hidden", display: "block", lineHeight: 1.35,
                                        whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit",
                                      }}
                                    />
                                    <button
                                      onClick={confirmarCalcTabela}
                                      aria-label="Confirmar conta"
                                      className="flex items-center justify-center rounded-lg"
                                      style={{ background: "#2D9E7F", width: 36, height: 36, flexShrink: 0 }}
                                    >
                                      <Check size={18} color="#FFF" strokeWidth={2.5} />
                                    </button>
                                  </div>
                                  {!tecladoProprio ? (
                                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
                                    <button
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => alternarTeclado(true)}
                                      title="Usar o teclado do app"
                                      style={{
                                        padding: "4px 8px", borderRadius: 8, fontSize: tFont * 0.8, fontWeight: 700,
                                        color: textColor, background: "transparent", border: `1px solid ${theme.lines}`,
                                      }}
                                    >
                                      Teclado do app
                                    </button>
                                    <button
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={alternarVirgulaAuto}
                                      aria-pressed={calcVirgulaAuto}
                                      title="Vírgula automática: digitar 832 vira 8,32"
                                      style={{
                                        padding: "4px 8px", borderRadius: 8, fontSize: tFont * 0.8, fontWeight: 700,
                                        color: calcVirgulaAuto ? "#FFF" : textColor,
                                        background: calcVirgulaAuto ? "#2D9E7F" : "transparent",
                                        border: `1px solid ${calcVirgulaAuto ? "#2D9E7F" : theme.lines}`,
                                      }}
                                    >
                                      ,00 auto
                                    </button>
                                    {["+", "−", "×", "÷", "(", ")"].map((op) => (
                                      <button
                                        key={op}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => inserirOperadorCalc(op)}
                                        style={{
                                          minWidth: 34, padding: "4px 8px", borderRadius: 8, fontSize: tFont * 0.9, fontWeight: 600,
                                          color: textColor, border: `1px solid ${theme.lines}`, background: "transparent",
                                        }}
                                      >
                                        {op}
                                      </button>
                                    ))}
                                    {previaCalc !== null && (
                                      <span style={{ marginLeft: "auto", fontSize: tFont * 0.9, fontWeight: 600, color: theme.textMuted }}>
                                        = {formatarMoedaBRL(previaCalc)}
                                      </span>
                                    )}
                                  </div>
                                  ) : (
                                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                      <button
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => alternarTeclado(false)}
                                        aria-label="Usar o teclado do celular"
                                        style={{
                                          display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 8,
                                          fontSize: tFont * 0.75, fontWeight: 600, color: theme.textMuted, border: `1px solid ${theme.lines}`,
                                        }}
                                      >
                                        <Keyboard size={14} /> Teclado do celular
                                      </button>
                                      {previaCalc !== null && (
                                        <div style={{ fontSize: tFont * 0.9, fontWeight: 600, color: theme.textMuted }}>
                                          = {formatarMoedaBRL(previaCalc)}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  {calcError && (
                                    <p role="alert" style={{ fontSize: tFont * 0.8, color: "#E53935" }}>{calcError}</p>
                                  )}
                                </div>
                              )}

                              {/* Histórico da conta: aparece ao maximizar pelo ícone ao lado do valor */}
                              {historicoCalc.length > 0 && !calcAberta && !histMinimizado && (
                                <div
                                  style={{
                                    padding: "4px 8px", borderRadius: 8,
                                    background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                                    fontSize: tFont * 0.75,
                                  }}
                                >
                                  {[...historicoCalc].reverse().map((h, hi) => {
                                    const origem = historicoCalc.length - 1 - hi;
                                    const conteudo = <>{h.expressao} = <strong>{formatarMoedaBRL(h.resultado)}</strong></>;
                                    return readOnly ? (
                                      <div key={hi} style={{ color: textColor, opacity: 0.8, overflowWrap: "anywhere" }}>{conteudo}</div>
                                    ) : (
                                      <button
                                        key={hi}
                                        onClick={() => abrirCalcTabela(idx, item, origem)}
                                        aria-label="Editar esta conta"
                                        style={{
                                          display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between",
                                          gap: 8, textAlign: "left", padding: "3px 0", color: textColor, opacity: 0.85, overflowWrap: "anywhere",
                                        }}
                                      >
                                        <span style={{ minWidth: 0 }}>{conteudo}</span>
                                        <Pencil size={Math.min(tFont * 0.75, 14)} style={{ flexShrink: 0, color: theme.textMuted }} />
                                      </button>
                                    );
                                  })}
                                  {!readOnly && (
                                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                                      <button
                                        onClick={() => setPendingClearCalc({ blockIdx: idx, itemId: item.id, label: item.nome || "esse item", valor: valorParaExibir(item.valor, false), total: historicoCalc.length })}
                                        aria-label="Excluir histórico da conta"
                                        style={{ display: "flex", alignItems: "center", gap: 3, color: "#E53935", fontWeight: 600, padding: "2px 6px" }}
                                      >
                                        <Trash2 size={Math.min(tFont * 0.75, 14)} /> Excluir histórico
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                          });
                        })()}
                      </div>

                      {!readOnly && (
                        <button
                          onClick={() => addTableItemAfter(idx)}
                          className="flex items-center gap-1 mt-2 py-1 hover:opacity-80 transition-opacity"
                          style={{ color: theme.textMuted, fontSize: tFont * 0.85 }}
                        >
                          <Plus size={tFont * 0.9} /> Adicionar item
                        </button>
                      )}

                      {/* Rodapé fixo com o total, sempre visível ao rolar a nota */}
                      <div
                        className="mt-2 flex items-center justify-between rounded-xl px-3 py-2 w-full min-w-0"
                        style={{
                          background: isDark ? "#1F1F1F" : "#1A1A2E",
                          boxShadow: "0 -2px 10px rgba(0,0,0,0.15)",
                        }}
                      >
                        <span className="font-medium shrink-0" style={{ color: "#BDBDBD", fontSize: tFont * 0.75 }}>Total da tabela</span>
                        <span className="font-bold shrink-0" style={{ color: "#FFF", fontSize: tFont * 1.05 }}>{formatarMoedaBRL(total)}</span>
                      </div>
                    </div>
                  );
                }

                if (block.type === "image" && block.url) {
                  return (
                    <div key={`img-${idx}`} className="relative group/img my-3 flex justify-center">
                      <div style={{ width: "100%", maxWidth: "100%", position: "relative" }}>
                        <img
                          src={block.url}
                          alt=""
                          onClick={() => { setViewingImage(block.url!); setViewZoom(1); setViewTx(0); setViewTy(0); setViewRotation(0); }}
                          style={{
                            width: "100%",
                            height: "auto",
                            maxHeight: "38vh",
                            objectFit: "contain",
                            borderRadius: 12,
                            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                            display: "block",
                            margin: "0 auto",
                            cursor: "zoom-in",
                          }}
                        />
                        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 6, zIndex: 5 }}>
                          <button
                            onClick={() => { setViewingImage(block.url!); setViewZoom(1); setViewTx(0); setViewTy(0); setViewRotation(0); }}
                            className="rounded-full text-white transition-all hover:bg-black/80 active:scale-95"
                            style={{ background: "rgba(0,0,0,0.7)", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,0.2)" }}
                            aria-label="Ver com lupa"
                            title="Ver ampliado"
                          >
                            <ScanSearch size={14} />
                          </button>
                          {!readOnly && (
                            <button
                              onClick={() => { setAnnotatorStartTool("crop"); setEditingImageIdx(idx); }}
                              className="rounded-full text-white transition-all hover:bg-black/80 active:scale-95"
                              style={{ background: "rgba(0,0,0,0.7)", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,0.3)" }}
                              aria-label="Cortar a foto"
                              title="Cortar a foto"
                            >
                              <Crop size={14} />
                            </button>
                          )}
                          {!readOnly && (
                            <button
                              onClick={() => { setAnnotatorStartTool(null); setEditingImageIdx(idx); }}
                              className="rounded-full text-white transition-all hover:bg-black/80 active:scale-95"
                              style={{ background: "rgba(0,0,0,0.7)", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,0.2)" }}
                              aria-label="Desenhar na imagem"
                              title="Editar / desenhar"
                            >
                              <Paintbrush size={14} />
                            </button>
                          )}
                          {!readOnly && (
                            <button
                              onClick={() => setPendingDeleteImageIdx(idx)}
                              className="rounded-full text-white transition-all hover:bg-black/80 active:scale-95"
                              style={{ background: "rgba(0,0,0,0.7)", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,0.2)" }}
                              aria-label="Remover imagem"
                            >
                              <X size={16} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                }

                return null;
              })}
            </div>

            {/* Word/char counter */}
            <div className="flex justify-end gap-3 pb-2">
              <span className="text-[13px]" style={{ color: theme.textMuted }}>
                {wordCount} {wordCount === 1 ? "palavra" : "palavras"}
              </span>
              <span className="text-[13px]" style={{ color: theme.textMuted }}>
                {charCount} caracteres
              </span>
            </div>
          </div>

          {/* Soma Total de todas as tabelas da nota — só aparece com 2 ou mais tabelas,
              fica fixa (fora da área de rolagem) pra sempre estar visível */}
          {(() => {
            const tabelas = blocks.filter((b) => b.type === "table" && b.tableItems);
            if (tabelas.length < 2) return null;
            const somaGeral = tabelas.reduce((soma, b) => soma + calcularTotalTabela(b.tableItems!), 0);
            const stFont = editorFontSize; // segue o mesmo ajuste A/A+/A++ do resto da nota
            const label = tabelas[0].somaTotalLabel ?? "Soma Total";
            return (
              <div
                className="mx-4 mb-2 flex items-center justify-between gap-2 rounded-xl px-3 py-2.5"
                style={{
                  background: isDark ? "#0F3D2E" : "#E8F5E9",
                  border: `1.5px solid ${isDark ? "#2D9E7F" : "#A5D6A7"}`,
                }}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <span style={{ fontSize: stFont * 0.85, flexShrink: 0 }}>🧮</span>
                  {readOnly ? (
                    <span className="font-bold truncate" style={{ color: isDark ? "#81C784" : "#2E7D32", fontSize: stFont * 0.8 }}>
                      {label} ({tabelas.length} tabelas)
                    </span>
                  ) : (
                    <input
                      value={label}
                      onChange={(e) => updateSomaTotalLabel(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      className="font-bold bg-transparent border-0 outline-none min-w-0 flex-1"
                      style={{ color: isDark ? "#81C784" : "#2E7D32", fontSize: stFont * 0.8 }}
                    />
                  )}
                </div>
                <span className="font-bold shrink-0" style={{ color: isDark ? "#81C784" : "#2E7D32", fontSize: stFont }}>
                  {formatarMoedaBRL(somaGeral)}
                </span>
              </div>
            );
          })()}

          {/* ── FAB inputs (hidden) ── */}
          {!readOnly && (
            <>
              <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleImageSelect} />
              <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageSelect} />
              <input ref={ocrCameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleOcrImage} />
              <input ref={ocrFileRef} type="file" accept="image/*" className="hidden" onChange={handleOcrImage} />
            </>
          )}

          {/* ── Painel de formatação do texto — abre pelo botão "Aa" da barra de baixo.
               Fica logo acima do teclado, em 2 linhas, sem precisar rolar para o lado.
               O menu Copiar/Recortar do Android não cobre mais esses botões. ── */}
          {!readOnly && showFormatBar && !(calcRow && tecladoProprio) && (
            <div
              className="flex flex-col gap-2 px-3 py-2 shrink-0"
              style={{ background: theme.toolbarBg, borderTop: `1px solid ${theme.lines}` }}
            >
              {activeBlockIdx !== null && blocks[activeBlockIdx]?.type === "text" ? (
                <>
                  {/* Linha 1: cores (só no trecho selecionado ou no que for digitado a seguir) + negrito */}
                  <div className="flex items-center gap-2.5 flex-wrap">
                    {TEXT_COLORS.map((c) => (
                      <button
                        key={c}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyInlineFormat(activeBlockIdx, "foreColor", c)}
                        style={{
                          width: 30, height: 30, borderRadius: "50%", background: c === TEXT_COLORS[0] ? textColor : c, flexShrink: 0,
                          border: c === TEXT_COLORS[0] ? `2px solid ${theme.lines}` : "2px solid transparent",
                        }}
                        title={c === TEXT_COLORS[0] ? "Cor normal do texto (muda sozinha no modo noturno)" : "Cor do texto selecionado"}
                        aria-label={c === TEXT_COLORS[0] ? "Cor normal do texto" : "Cor do texto selecionado"}
                      />
                    ))}
                    <div style={{ width: 1, height: 22, background: theme.lines, flexShrink: 0 }} />
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => applyInlineFormat(activeBlockIdx, "bold")}
                      title="Negrito no texto selecionado"
                      aria-label="Negrito no texto selecionado"
                      style={{
                        width: 34, height: 34, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                        background: "transparent",
                        border: `1px solid ${theme.lines}`, color: theme.text,
                      }}
                    >
                      <BoldIcon size={16} />
                    </button>
                  </div>

                  {/* Linha 2: fonte, alinhamento (parágrafo inteiro) e dividir o bloco no cursor */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        const keys = Object.keys(FONT_OPTIONS);
                        const cur = blocks[activeBlockIdx].style?.font || "default";
                        const next = keys[(keys.indexOf(cur) + 1) % keys.length];
                        applyTextStyle(activeBlockIdx, { font: next });
                      }}
                      title="Trocar fonte (parágrafo inteiro)"
                      style={{ fontSize: 12, fontWeight: 700, padding: "0 10px", height: 34, borderRadius: 8, background: "transparent", border: `1px solid ${theme.lines}`, color: theme.text, flexShrink: 0, whiteSpace: "nowrap" }}
                    >
                      {FONT_OPTIONS[blocks[activeBlockIdx].style?.font || "default"].label}
                    </button>

                    <div style={{ width: 1, height: 22, background: theme.lines, flexShrink: 0 }} />

                    {([
                      { v: "left", icon: <AlignLeft size={16} /> },
                      { v: "center", icon: <AlignCenter size={16} /> },
                      { v: "right", icon: <AlignRight size={16} /> },
                    ] as const).map((a) => (
                      <button
                        key={a.v}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyTextStyle(activeBlockIdx, { align: a.v })}
                        title={`Alinhar à ${a.v === "left" ? "esquerda" : a.v === "center" ? "centro" : "direita"}`}
                        style={{
                          width: 34, height: 34, borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                          background: (blocks[activeBlockIdx].style?.align || "left") === a.v ? theme.borderAccent : "transparent",
                          border: `1px solid ${theme.lines}`, color: theme.text,
                        }}
                      >
                        {a.icon}
                      </button>
                    ))}

                    <div style={{ width: 1, height: 22, background: theme.lines, flexShrink: 0 }} />

                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => splitBlockAtCursor(activeBlockIdx)}
                      title="Dividir texto aqui (cada parte pode ter formatação diferente)"
                      style={{
                        display: "flex", alignItems: "center", gap: 4, padding: "0 10px", height: 34, borderRadius: 8, flexShrink: 0,
                        background: "transparent", border: `1px solid ${theme.lines}`, color: theme.text, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                      }}
                    >
                      <Scissors size={14} /> Dividir aqui
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: theme.textMuted, textAlign: "center", padding: "6px 0" }}>
                  Toque dentro de um texto para formatar
                </div>
              )}
            </div>
          )}

          {/* ── TECLADO DO APP (números e operações): ocupa o lugar do rodapé enquanto a calculadora da linha está aberta ── */}
          {!readOnly && calcRow && tecladoProprio ? (
            <div
              className="shrink-0"
              style={{
                background: theme.toolbarBg,
                borderTop: `1px solid ${theme.lines}`,
                padding: "8px 8px calc(4px + env(safe-area-inset-bottom))",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {(() => {
                const base: React.CSSProperties = {
                  height: 46, borderRadius: 12, fontSize: 21, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center",
                  userSelect: "none", WebkitUserSelect: "none", touchAction: "manipulation",
                };
                const num: React.CSSProperties = { ...base, color: textColor, background: isDark ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.8)" };
                const fn: React.CSSProperties = { ...base, color: textColor, background: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)" };
                const op: React.CSSProperties = { ...base, fontSize: 24, color: "#2D9E7F", background: isDark ? "rgba(76,175,80,0.16)" : "rgba(45,158,127,0.14)" };
                const prox: React.CSSProperties = { ...base, fontSize: 15, gap: 2, color: "#FFF", background: "#2D9E7F" };
                const K = (key: string, label: React.ReactNode, style: React.CSSProperties, onPress: () => void, aria: string) => (
                  <button key={key} type="button" aria-label={aria} style={style} onMouseDown={(e) => e.preventDefault()} onClick={onPress}>
                    {label}
                  </button>
                );
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 6 }}>
                    {K("c", "C", fn, tecladoLimpar, "Limpar")}
                    {K("bk", <BackspaceIcon size={22} />, fn, tecladoApagar, "Apagar")}
                    {K("pct", "%", fn, tecladoPercent, "Porcentagem")}
                    {K("div", "÷", op, () => inserirOperadorCalc("÷"), "Dividir")}
                    {K("7", "7", num, () => tecladoDigito("7"), "7")}
                    {K("8", "8", num, () => tecladoDigito("8"), "8")}
                    {K("9", "9", num, () => tecladoDigito("9"), "9")}
                    {K("mul", "×", op, () => inserirOperadorCalc("×"), "Multiplicar")}
                    {K("4", "4", num, () => tecladoDigito("4"), "4")}
                    {K("5", "5", num, () => tecladoDigito("5"), "5")}
                    {K("6", "6", num, () => tecladoDigito("6"), "6")}
                    {K("sub", "−", op, () => inserirOperadorCalc("−"), "Subtrair")}
                    {K("1", "1", num, () => tecladoDigito("1"), "1")}
                    {K("2", "2", num, () => tecladoDigito("2"), "2")}
                    {K("3", "3", num, () => tecladoDigito("3"), "3")}
                    {K("add", "+", op, () => inserirOperadorCalc("+"), "Somar")}
                    {K("vg", ",", num, () => tecladoSeparador(","), "Vírgula")}
                    {K("0", "0", num, () => tecladoDigito("0"), "0")}
                    {K("pt", ".", num, () => tecladoSeparador("."), "Ponto")}
                    {K("nx", <>Próximo<ChevronRight size={18} /></>, prox, tecladoProximo, "Lançar e ir para a próxima linha")}
                  </div>
                );
              })()}
            </div>
          ) : !readOnly ? (
            <div
              className="flex items-center justify-between px-5 shrink-0"
              style={{
                background: theme.toolbarBg,
                borderTop: `1px solid ${theme.lines}`,
                paddingTop: 3,
                paddingBottom: "calc(2px + env(safe-area-inset-bottom))",
                gap: 12,
              }}
            >
              {/* Esquerda: FAB ⋮ e botão Aa (abre o painel de formatação) */}
              <div className="flex items-center gap-2">
              <div className="relative">
                {showFab && (
                  <>
                    <div className="fixed inset-0 z-[60]" onClick={() => setShowFab(false)} />
                    <div
                      className="absolute z-[70] flex flex-col gap-2"
                      style={{ bottom: 50, left: 0, minWidth: 180 }}
                    >
                      {[
                        { icon: <Camera size={18} />, label: "Câmera", action: async () => { setShowFab(false); if (isNative()) { const f = await takeNativePhoto("camera"); if (f) await addPhotos([f]); } else { cameraInputRef.current?.click(); } } },
                        { icon: <ImagePlus size={18} />, label: "Galeria", action: async () => { setShowFab(false); if (isNative()) { const f = await takeNativePhoto("gallery"); if (f) await addPhotos([f]); } else { fileInputRef.current?.click(); } } },
                        ...(isNative() ? [{ icon: <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>🖼️</span>, label: "Galeria (várias)", action: () => { setShowFab(false); fileInputRef.current?.click(); } }] : []),
                        { icon: <Crop size={18} />, label: cropOnAdd ? "Cortar ao adicionar: sim" : "Cortar ao adicionar: não", action: () => { toggleCropOnAdd(); } },
                        { icon: ocrLoading ? <Loader2 size={18} className="animate-spin" /> : <ScanSearch size={18} />, label: "OCR", action: () => { setShowOcrModal(true); setShowFab(false); } },
                        { icon: qrLoading ? <Loader2 size={18} className="animate-spin" /> : <ScanLine size={18} />, label: "QR", action: () => { handleStartQrScanner(); setShowFab(false); } },
                        { icon: <ListChecks size={18} />, label: "Lista", action: () => { addChecklist(); setShowFab(false); } },
                        { icon: <Table2 size={18} />, label: "Tabela Manual", action: () => { addTable(); setShowFab(false); } },
                        ...(voiceSupported ? [{ icon: isListening ? <MicOff size={18} /> : <Mic size={18} />, label: isListening ? "Parar voz" : "Voz", action: () => { toggleVoice(); setShowFab(false); } }] : []),
                        ...(onSchedule ? [{ icon: <CalendarPlus size={18} />, label: "Agendar", action: () => { setScheduleDate(new Date().toISOString().slice(0, 10)); setScheduleTime("09:00"); setScheduleSound(null); setShowScheduleDialog(true); setShowFab(false); } }] : []),
                        ...(temFotos ? [{
                          icon: reduzindoFotos ? <Loader2 size={18} className="animate-spin" /> : <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>📉</span>,
                          label: reduzindoFotos ? "Reduzindo…" : fotosNoMinimo ? `Fotos no mínimo · ${formatarMB(bytesFotos)}` : `Reduzir fotos · ${formatarMB(bytesFotos)}`,
                          // não fecha o menu: dá para tocar de novo e ver o tamanho cair
                          action: () => { reduzirFotosDaNota(); },
                          disabled: reduzindoFotos || fotosNoMinimo,
                        }] : []),
                        { icon: <Undo2 size={18} />, label: "Desfazer", action: () => { undo(); setShowFab(false); }, disabled: !canUndo },
                        { icon: <Redo2 size={18} />, label: "Refazer", action: () => { redo(); setShowFab(false); }, disabled: !canRedo },
                      ].map((item, i) => (
                        <button
                          key={i}
                          onClick={item.action}
                          disabled={item.disabled}
                          className="flex items-center gap-3 px-4 py-2.5 rounded-2xl transition-all active:scale-95"
                          style={{
                            background: isDark ? "#3A3A3A" : "#FFFFFF",
                            color: item.disabled ? "#BDBDBD" : (isDark ? "#FFF" : "#1A1A2E"),
                            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                            opacity: item.disabled ? 0.5 : 1,
                          }}
                        >
                          <span style={{ color: isDark ? "#FFF" : theme.textMuted }}>{item.icon}</span>
                          <span className="text-sm font-semibold">{item.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <button
                  onClick={() => setShowFab((v) => !v)}
                  className="flex items-center justify-center rounded-full transition-all active:scale-95"
                  style={{
                    width: 40, height: 40,
                    background: showFab ? "#1A1A2E" : theme.headerBg,
                    border: `2px solid ${theme.borderAccent}`,
                    color: showFab ? "#FFF" : theme.textMuted,
                  }}
                  title="Opções"
                >
                  {showFab ? <X size={20} /> : (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
                    </svg>
                  )}
                </button>
              </div>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setShowFormatBar((v) => !v)}
                className="flex items-center justify-center rounded-full transition-all active:scale-95"
                style={{
                  width: 40, height: 40,
                  background: showFormatBar ? "#1A1A2E" : theme.headerBg,
                  border: `2px solid ${theme.borderAccent}`,
                  color: showFormatBar ? "#FFF" : theme.textMuted,
                  fontSize: 15, fontWeight: 800, lineHeight: 1,
                }}
                title="Formatação do texto (cor, negrito, alinhar, fonte, dividir)"
                aria-label="Formatação do texto"
                aria-pressed={showFormatBar}
              >
                Aa
              </button>
              </div>

              {/* Salvar ✓ — centro */}
              <button
                onClick={editingNote ? handleSaveAndBackToView : () => doSaveAndClose("publicada")}
                disabled={!title.trim() && !blocksToPlainText(blocks).trim()}
                className="flex items-center justify-center rounded-full transition-all active:scale-95 disabled:opacity-50"
                style={{ background: "#2D9E7F", width: 40, height: 40, boxShadow: "0 4px 14px rgba(45,158,127,0.4)" }}
                title="Salvar"
              >
                <Check size={20} color="#FFF" strokeWidth={2.5} />
              </button>

              <div className="flex items-center justify-end gap-2">
              <div style={{ width: 40, height: 40 }} aria-hidden />
              {/* Fechar — direita, mesmo tamanho do "⋮" à esquerda. Antes era
                  só um espaço vazio pra centralizar o Salvar; agora dá acesso
                  rápido pra fechar a nota sem esticar o polegar até o topo. */}
              <button
                onClick={handleClose}
                className="flex items-center justify-center rounded-full transition-all active:scale-95"
                style={{ width: 40, height: 40, background: theme.headerBg, border: `2px solid ${theme.borderAccent}`, color: theme.textMuted }}
                title="Fechar"
                aria-label="Fechar"
              >
                <X size={20} />
              </button>
              </div>
            </div>
          ) : (
            <div
              className="flex flex-wrap gap-x-3 gap-y-1.5 px-3 pt-2 shrink-0 justify-between items-center"
              style={{
                background: theme.toolbarBg,
                borderTop: `1px solid ${theme.lines}`,
                paddingBottom: "calc(4px + env(safe-area-inset-bottom))",
              }}
            >
              {/* Linha de cima: Leitura Limpa à esquerda, lixeira no meio, Ouvir à direita */}
              <div style={{ width: "100%", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 8 }}>
                <div style={{ justifySelf: "start" }}>
                <button
                  onClick={() => setReadingMode(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold whitespace-nowrap transition-all active:scale-95"
                  style={{ background: "transparent", border: `1px solid ${theme.lines}`, color: textColor }}
                  title="Modo de leitura limpo"
                >
                  📖 Leitura Limpa
                </button>
                </div>
                <div style={{ justifySelf: "center" }}>
                  {editingNote && onDelete && (
                    <button
                      onClick={() => setShowDeleteConfirm(true)}
                      className="flex items-center justify-center rounded-full transition-all active:scale-95"
                      style={{ width: 36, height: 36, background: "transparent", border: `1px solid ${isDark ? "#E57373" : "#E53935"}`, color: isDark ? "#E57373" : "#E53935" }}
                      title="Excluir nota"
                      aria-label="Excluir nota"
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
                <div style={{ justifySelf: "end" }}>
                <button
                  onClick={toggleReadAloud}
                  aria-pressed={isSpeaking}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold whitespace-nowrap transition-all active:scale-95"
                  style={{
                    background: isSpeaking ? theme.borderAccent : "transparent",
                    border: `1px solid ${theme.lines}`,
                    color: isSpeaking ? (isDark ? "#1A1A2E" : "#FFF") : textColor,
                  }}
                  title={isSpeaking ? "Parar a leitura" : "Ouvir a nota em voz alta"}
                >
                  {isSpeaking ? "⏹️ Parar" : "🔊 Ouvir"}
                </button>
                </div>
              </div>

              {/* Linha de baixo: Modo visualização à esquerda, Editar à direita */}
              <div className="flex items-center justify-between gap-2 w-full">
                <span className="text-[13px] font-semibold whitespace-nowrap" style={{ color: theme.textMuted }}>👁️ Modo visualização</span>
                {editingNote && (
                  <button
                    onClick={enterEditMode}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-semibold text-white whitespace-nowrap shadow-sm hover:shadow-md transition-all duration-200"
                    style={{ background: "#2D9E7F" }}
                  >
                    ✏️ Editar
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── UNSAVED CHANGES PROMPT ── */}
          {showUnsavedPrompt && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }}>
              <div className="rounded-2xl p-5 w-[90%] max-w-xs space-y-4" style={{ background: "#FFF", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
                <h3 className="text-base font-bold text-center" style={{ color: "#1A1A2E" }}>
                  Alterações não salvas
                </h3>
                <p className="text-sm text-center" style={{ color: "#666" }}>
                  Deseja salvar as alterações antes de sair?
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => {
                      setShowUnsavedPrompt(false);
                      const serialized = serializeBlocks(blocks);
                      const imageUrls: string[] = []; // as fotos já ficam dentro do texto da nota (serialized); gravar a lista separada duplicava tudo
                      onSave(title, serialized, imageUrls, selectedColor, "default", "medium", editingNote?.status === "rascunho" ? "rascunho" : "publicada");
                      clearDraft();
                      snapshotRef.current = null;
                      onOpenChange(false);
                      toast({ title: "Nota salva ✓" });
                    }}
                    className="w-full px-4 py-2.5 rounded-xl text-sm font-bold text-white transition-colors"
                    style={{ background: "#2D9E7F" }}
                  >
                    Salvar e sair
                  </button>
                  <button
                    onClick={() => {
                      setShowUnsavedPrompt(false);
                      cancelEdit();
                      clearDraft();
                      snapshotRef.current = null;
                      onOpenChange(false);
                    }}
                    className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                    style={{ background: "#F5F5F5", color: "#E53935" }}
                  >
                    Descartar alterações
                  </button>
                  <button
                    onClick={() => setShowUnsavedPrompt(false)}
                    className="w-full text-center text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors"
                    style={{ color: "#9E9E9E" }}
                  >
                    Continuar editando
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── SHARE MODAL ── */}
        {showShareModal && (
          <div className="absolute inset-0 z-50 flex items-end justify-center" style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setShowShareModal(false)}>
            <div
              className="w-full rounded-t-3xl p-6 space-y-3"
              style={{ background: "#FFF", boxShadow: "0 -8px 40px rgba(0,0,0,0.15)", maxWidth: 480 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: "#E0E0E0" }} />
              <h3 className="text-base font-bold text-center mb-4" style={{ color: "#1A1A2E" }}>
                Compartilhar nota
              </h3>

              {/* WhatsApp */}
              <button
                onClick={() => {
                  const text = encodeURIComponent(`${title}

${blocksToPlainText(blocks)}`.trim());
                  window.open(`https://wa.me/?text=${text}`, "_blank");
                  setShowShareModal(false);
                }}
                className="w-full flex items-center gap-4 px-4 py-3 rounded-2xl transition-all hover:bg-gray-50 active:scale-95"
                style={{ border: "1px solid #E8F5E9" }}
              >
                <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: "#25D366" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                </div>
                <div className="text-left">
                  <div className="text-sm font-semibold" style={{ color: "#1A1A2E" }}>WhatsApp</div>
                  <div className="text-sm" style={{ color: "#9E9E9E" }}>Enviar via WhatsApp</div>
                </div>
              </button>

              {/* Email */}
              <button
                onClick={() => {
                  const subject = encodeURIComponent(title || "Nota");
                  const body = encodeURIComponent(`${title}

${blocksToPlainText(blocks)}`.trim());
                  window.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
                  setShowShareModal(false);
                }}
                className="w-full flex items-center gap-4 px-4 py-3 rounded-2xl transition-all hover:bg-gray-50 active:scale-95"
                style={{ border: "1px solid #E3F2FD" }}
              >
                <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: "#2196F3" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                </div>
                <div className="text-left">
                  <div className="text-sm font-semibold" style={{ color: "#1A1A2E" }}>E-mail</div>
                  <div className="text-sm" style={{ color: "#9E9E9E" }}>Enviar por e-mail</div>
                </div>
              </button>


              {/* Copiar texto */}
              <button
                onClick={async () => {
                  const text = `${title}

${blocksToPlainText(blocks)}`.trim();
                  try {
                    await navigator.clipboard.writeText(text);
                    toast({ title: "✅ Copiado!", description: "Texto copiado para a área de transferência." });
                  } catch {
                    toast({ title: "Erro", description: "Não foi possível copiar." });
                  }
                  setShowShareModal(false);
                }}
                className="w-full flex items-center gap-4 px-4 py-3 rounded-2xl transition-all hover:bg-gray-50 active:scale-95"
                style={{ border: "1px solid #F3E5F5" }}
              >
                <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: "#9C27B0" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                </div>
                <div className="text-left">
                  <div className="text-sm font-semibold" style={{ color: "#1A1A2E" }}>Copiar texto</div>
                  <div className="text-sm" style={{ color: "#9E9E9E" }}>Copiar para área de transferência</div>
                </div>
              </button>

              {/* Compartilhar nativo — sempre visível: usa o plugin nativo
                  dentro do app instalado, e navigator.share no navegador. */}
              <button
                onClick={async () => {
                  const text = `${title}

${blocksToPlainText(blocks)}`.trim();
                  const result = await shareText(title || "Nota", text);
                  if (result === "copied") {
                    toast({ title: "✅ Copiado!", description: "Nota copiada para a área de transferência." });
                  } else if (result === "failed") {
                    toast({ title: "Não foi possível compartilhar nem copiar", variant: "destructive" });
                  }
                  setShowShareModal(false);
                }}
                className="w-full flex items-center gap-4 px-4 py-3 rounded-2xl transition-all hover:bg-gray-50 active:scale-95"
                style={{ border: "1px solid #E8EAF6" }}
              >
                <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: "#3F51B5" }}>
                  <Share2 size={20} color="white" />
                </div>
                <div className="text-left">
                  <div className="text-sm font-semibold" style={{ color: "#1A1A2E" }}>Mais opções</div>
                  <div className="text-sm" style={{ color: "#9E9E9E" }}>WhatsApp, Telegram, SMS e outros</div>
                </div>
              </button>

              <button
                onClick={() => setShowShareModal(false)}
                className="w-full py-3 text-sm font-medium rounded-2xl mt-1"
                style={{ background: "#F5F5F5", color: "#666" }}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* ── OCR MODAL ── */}
        {/* Modal de Agendar — estava faltando, botão existia mas não abria nada */}
        {showScheduleDialog && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowScheduleDialog(false)}>
            <div className="bg-white rounded-2xl p-6 mx-4 shadow-xl max-w-xs w-full" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-base font-semibold text-gray-800 mb-1 flex items-center gap-2">
                <CalendarPlus size={18} className="text-gray-600" /> Agendar nota
              </h3>
              <p className="text-sm text-gray-500 mb-4">
                Cria um compromisso na Agenda com o título e o conteúdo desta nota.
              </p>

              <label className="block text-sm font-medium text-gray-600 mb-1">Data</label>
              <input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                className="w-full mb-3 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-800 outline-none focus:border-yellow-400"
              />

              <label className="block text-sm font-medium text-gray-600 mb-1">Hora</label>
              <input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="w-full mb-4 px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-800 outline-none focus:border-yellow-400"
              />

              <label className="block text-sm font-medium text-gray-600 mb-1.5">Som do alerta (toque para ouvir e escolher)</label>
              <div className="grid grid-cols-2 gap-1.5 mb-4">
                {ALERT_SOUND_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => { setScheduleSound(opt.id); playAlertSoundPreview(opt.id); }}
                    className="text-left px-2.5 py-2 rounded-lg text-xs font-semibold transition-all"
                    style={
                      scheduleSound === opt.id
                        ? { background: "#1A1A2E", color: "#FFF" }
                        : { background: "rgba(0,0,0,0.05)", border: "1px solid #E0E0E0", color: "#555" }
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setShowScheduleDialog(false)}
                  className="flex-1 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    if (!scheduleDate) {
                      toast({ title: "Escolha uma data", description: "Selecione a data do compromisso." });
                      return;
                    }
                    if (!scheduleSound) {
                      toast({ title: "Escolha um som de alerta", description: "Toque numa das opções antes de agendar." });
                      return;
                    }
                    onSchedule?.(title || "Nota sem título", blocksToPlainText(blocks), scheduleDate, scheduleTime, scheduleSound);
                    setShowScheduleDialog(false);
                    toast({ title: "📅 Agendado!", description: "Compromisso criado na Agenda." });
                  }}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold text-white transition-colors"
                  style={{ background: "#2D9E7F" }}
                >
                  Agendar
                </button>
              </div>
            </div>
          </div>
        )}

        {showOcrModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-2xl p-6 mx-4 shadow-xl max-w-xs w-full">
              <h3 className="text-base font-semibold text-gray-800 mb-1">Extrair texto (OCR)</h3>
              <p className="text-sm text-gray-500 mb-4">De onde deseja extrair o texto?</p>
              <div className="flex gap-3">
                <button
                  onClick={() => { if (isNative()) openOcrNativeCamera(); else ocrCameraRef.current?.click(); }}
                  className="flex-1 flex flex-col items-center gap-2 py-4 rounded-xl border-2 border-gray-200 hover:border-yellow-400 hover:bg-yellow-50 transition-all"
                >
                  <Camera size={24} className="text-gray-600" />
                  <span className="text-sm font-medium text-gray-700">Câmera</span>
                </button>
                <button
                  onClick={() => ocrFileRef.current?.click()}
                  className="flex-1 flex flex-col items-center gap-2 py-4 rounded-xl border-2 border-gray-200 hover:border-yellow-400 hover:bg-yellow-50 transition-all"
                >
                  <ImagePlus size={24} className="text-gray-600" />
                  <span className="text-sm font-medium text-gray-700">Galeria</span>
                </button>
              </div>
              <button
                onClick={() => setShowOcrModal(false)}
                className="w-full mt-3 py-2 text-sm text-gray-500 hover:text-gray-800 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* QR/Barcode Scanner Modal */}
        {showQrScanner && (
          <div className="absolute inset-0 z-50 flex flex-col bg-black">
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", paddingTop: "calc(16px + env(safe-area-inset-top))" }}>
              <span style={{ color: "#FFF", fontWeight: 700, fontSize: 16 }}>📷 Leitor de Código</span>
              <button onClick={handleStopQrScanner} style={{ width: 36, height: 36, borderRadius: "50%", background: "rgba(255,255,255,0.15)", border: "none", color: "#FFF", fontSize: 18, cursor: "pointer" }}>✕</button>
            </div>
            {/* Vídeo */}
            <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <video ref={qrVideoRef} playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              <canvas ref={qrCanvasRef} style={{ display: "none" }} />
              {/* Mira */}
              {!qrLoading && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                  <div style={{ width: "65%", aspectRatio: "1", position: "relative" }}>
                    {[{top:0,left:0},{top:0,right:0},{bottom:0,left:0},{bottom:0,right:0}].map((pos, i) => (
                      <div key={i} style={{ position: "absolute", width: 28, height: 28, borderTop: (pos as any).top===0?"3px solid #2D9E7F":"none", borderBottom: (pos as any).bottom===0?"3px solid #2D9E7F":"none", borderLeft: (pos as any).left===0?"3px solid #2D9E7F":"none", borderRight: (pos as any).right===0?"3px solid #2D9E7F":"none", ...pos }} />
                    ))}
                    <div style={{ position: "absolute", left: 4, right: 4, height: 2, background: "linear-gradient(90deg,transparent,#2D9E7F,transparent)", animation: "scanline 1.5s ease-in-out infinite", top: "50%" }} />
                  </div>
                </div>
              )}
              {/* Loading */}
              {qrLoading && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)" }}>
                  <div style={{ width: 36, height: 36, border: "3px solid rgba(255,255,255,0.2)", borderTop: "3px solid #2D9E7F", borderRadius: "50%", animation: "spin 0.8s linear infinite", marginBottom: 12 }} />
                  <span style={{ color: "#FFF", fontSize: 13 }}>Iniciando câmera...</span>
                </div>
              )}
            </div>
            <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, textAlign: "center", padding: "12px 0 4px" }}>Aponte para QR Code ou código de barras</p>
            <button onClick={handleStopQrScanner} style={{ margin: "8px 16px 32px", padding: "12px 0", borderRadius: 12, background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)", color: "#FFF", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Cancelar</button>
            <style>{`@keyframes scanline{0%,100%{top:10%}50%{top:85%}}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* OCR Loading overlay */}
        {ocrLoading && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/30 gap-3">
            <Loader2 size={32} className="animate-spin text-white" />
            <p className="text-white text-sm font-medium">Extraindo texto da imagem...</p>
          </div>
        )}

        {/* Editor de desenho (tipo Paint) em cima da imagem */}
        {editingImageIdx !== null && blocks[editingImageIdx]?.url && (
          <AnnotatorErrorBoundary onCancel={() => setEditingImageIdx(null)}>
            <ImageAnnotator
              imageUrl={blocks[editingImageIdx].url!}
              initialTool={annotatorStartTool || undefined}
              onSave={(newUrl) => { updateImageBlock(editingImageIdx, newUrl); setEditingImageIdx(null); setAnnotatorStartTool(null); }}
              onCancel={() => { setEditingImageIdx(null); setAnnotatorStartTool(null); }}
            />
          </AnnotatorErrorBoundary>
        )}

        {/* Cortar ao adicionar: abre cada foto escolhida no modo corte, antes de entrar na nota */}
        {addCrop && (
          <AnnotatorErrorBoundary onCancel={() => { const q = addCropQueueRef.current; if (q) { q.results.push(q.files[q.i]); void advanceAddCrop(); } else setAddCrop(null); }}>
            <ImageAnnotator
              key={addCrop.index}
              imageUrl={addCrop.dataUrl}
              initialTool="crop"
              title={addCrop.total > 1 ? `✂️ Foto ${addCrop.index} de ${addCrop.total}` : "✂️ Cortar foto"}
              cancelLabel="Sem cortar"
              saveLabel="Adicionar"
              saveQuality={0.95}
              onSave={(newUrl) => {
                const q = addCropQueueRef.current;
                if (!q) { setAddCrop(null); return; }
                q.results.push(dataUrlToFile(newUrl, `foto_${Date.now()}_${q.i}.jpg`));
                void advanceAddCrop();
              }}
              onCancel={() => {
                const q = addCropQueueRef.current;
                if (!q) { setAddCrop(null); return; }
                q.results.push(q.files[q.i]);
                void advanceAddCrop();
              }}
            />
          </AnnotatorErrorBoundary>
        )}

        {/* Confirmação antes de excluir um item da tabela ou checklist */}
        {showDeleteConfirm && editingNote && (
          <div
            className="absolute inset-0 z-[95] flex items-center justify-center p-5"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setShowDeleteConfirm(false)}
          >
            <div
              className="w-full"
              style={{ maxWidth: 320, background: theme.card, borderRadius: 18, padding: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <p style={{ fontWeight: 700, fontSize: 15, color: theme.text, margin: "0 0 6px" }}>🗑 Mover para a lixeira?</p>
              <p style={{ fontSize: 13, color: theme.textMuted, margin: "0 0 16px" }}>
                A nota "{editingNote.title || "Sem título"}" pode ser recuperada em até 30 dias.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: isDark ? "#333" : "#F0F0F0", color: theme.text, fontWeight: 600, fontSize: 13 }}
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    onDelete?.(editingNote.id);
                    setShowDeleteConfirm(false);
                    onOpenChange(false);
                  }}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#E53935", color: "#FFF", fontWeight: 600, fontSize: 13 }}
                >
                  Mover para lixeira
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingDeleteImageIdx !== null && (
          <div
            className="absolute inset-0 z-[95] flex items-center justify-center p-5"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setPendingDeleteImageIdx(null)}
          >
            <div
              className="w-full"
              style={{ maxWidth: 320, background: theme.card, borderRadius: 18, padding: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <p style={{ fontWeight: 700, fontSize: 15, color: theme.text, margin: "0 0 6px" }}>🗑 Remover essa foto?</p>
              <p style={{ fontSize: 13, color: theme.textMuted, margin: "0 0 16px" }}>
                Essa ação não pode ser desfeita. O resto da nota continua igual.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setPendingDeleteImageIdx(null)}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: isDark ? "#333" : "#F0F0F0", color: theme.text, fontWeight: 600, fontSize: 13 }}
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    if (pendingDeleteImageIdx !== null) removeImageBlock(pendingDeleteImageIdx);
                    setPendingDeleteImageIdx(null);
                  }}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#E53935", color: "#FFF", fontWeight: 600, fontSize: 13 }}
                >
                  Remover foto
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingDeleteItem && (
          <div
            className="absolute inset-0 z-[90] flex items-center justify-center p-5"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setPendingDeleteItem(null)}
          >
            <div
              className="w-full"
              style={{ maxWidth: 320, background: theme.card, borderRadius: 18, padding: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <p style={{ fontWeight: 700, fontSize: 15, color: theme.text, margin: "0 0 6px" }}>Excluir item?</p>
              <p style={{ fontSize: 13, color: theme.textMuted, margin: "0 0 16px" }}>
                Tem certeza que quer excluir "{pendingDeleteItem.label}"? Essa ação não pode ser desfeita.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setPendingDeleteItem(null)}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: isDark ? "#333" : "#F0F0F0", color: theme.text, fontWeight: 600, fontSize: 13 }}
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    if (pendingDeleteItem.type === "table") removeTableItem(pendingDeleteItem.blockIdx, pendingDeleteItem.itemId);
                    else removeChecklistItem(pendingDeleteItem.blockIdx, pendingDeleteItem.itemId);
                    setPendingDeleteItem(null);
                  }}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#E53935", color: "#FFF", fontWeight: 600, fontSize: 13 }}
                >
                  Excluir
                </button>
              </div>
            </div>
          </div>
        )}

        {pendingClearCalc && (
          <div
            className="absolute inset-0 z-[90] flex items-center justify-center p-5"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setPendingClearCalc(null)}
          >
            <div
              className="w-full"
              style={{ maxWidth: 320, background: theme.card, borderRadius: 18, padding: 20 }}
              onClick={(e) => e.stopPropagation()}
            >
              <p style={{ fontWeight: 700, fontSize: 15, color: theme.text, margin: "0 0 6px" }}>Excluir histórico da conta?</p>
              <p style={{ fontSize: 13, color: theme.textMuted, margin: "0 0 16px" }}>
                {pendingClearCalc.total === 1 ? "A conta" : `As ${pendingClearCalc.total} contas`} de "{pendingClearCalc.label}" {pendingClearCalc.total === 1 ? "será apagada" : "serão apagadas"}.
                {pendingClearCalc.valor ? ` O valor ${pendingClearCalc.valor} continua na linha.` : ""} Essa ação não pode ser desfeita.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => setPendingClearCalc(null)}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: isDark ? "#333" : "#F0F0F0", color: theme.text, fontWeight: 600, fontSize: 13 }}
                >
                  Cancelar
                </button>
                <button
                  onClick={() => {
                    updateTableItem(pendingClearCalc.blockIdx, pendingClearCalc.itemId, { calc: undefined });
                    setPendingClearCalc(null);
                  }}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", background: "#E53935", color: "#FFF", fontWeight: 600, fontSize: 13 }}
                >
                  Excluir
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Visualizador com lupa (ver a imagem ampliada, sem editar).
            Desenhado direto no corpo da página (portal), com a foto ocupando a tela
            inteira, como numa foto da galeria. Os botões flutuam por cima, somem
            sozinhos e voltam com um toque na foto. */}
        {viewingImage && typeof document !== "undefined" && createPortal(
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 90,
              pointerEvents: "auto",
              touchAction: "none",
              background: `rgba(0,0,0,${viewCloseOpacity})`,
            }}
            onClick={() => setViewingImage(null)}
          >
            {/* Fundo: a própria foto desfocada e escurecida, no lugar das faixas pretas */}
            <div
              aria-hidden="true"
              style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden", pointerEvents: "none", opacity: viewCloseOpacity }}
            >
              <img
                src={viewingImage}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", objectFit: "cover", filter: "blur(28px) brightness(0.55)", transform: "scale(1.15)" }}
              />
            </div>
            <div
              ref={viewerContainerRef}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                touchAction: "none",
              }}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={handleViewerPointerDown}
              onPointerMove={handleViewerPointerMove}
              onPointerUp={(e) => handleViewerPointerUp(e, noteImages)}
              onPointerCancel={(e) => handleViewerPointerUp(e, noteImages)}
              onWheel={handleViewerWheel}
            >
              <img
                ref={viewerImgRef}
                src={viewingImage}
                alt=""
                onLoad={handleViewerImgLoad}
                draggable={false}
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  width: "auto",
                  height: "auto",
                  display: "block",
                  objectFit: "contain",
                  transformOrigin: "50% 50%",
                  transform: `translate(${viewTx}px, ${viewTy}px) rotate(${viewRotation}deg) scale(${viewZoom})`,
                  transition: viewDragging ? "none" : "transform 0.25s ease",
                  userSelect: "none",
                }}
              />

              {noteImages.length > 1 && viewZoom <= 1.01 && viewerUiVisible && (
                <>
                  {viewIndex > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); goToImage(noteImages, viewIndex - 1); }}
                      style={{ position: "absolute", top: "50%", left: 10, transform: "translateY(-50%)", width: 34, height: 34, borderRadius: "50%", background: "rgba(0,0,0,0.7)", border: "none", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <ChevronLeft size={20} />
                    </button>
                  )}
                  {viewIndex < noteImages.length - 1 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); goToImage(noteImages, viewIndex + 1); }}
                      style={{ position: "absolute", top: "50%", right: 10, transform: "translateY(-50%)", width: 34, height: 34, borderRadius: "50%", background: "rgba(0,0,0,0.7)", border: "none", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center" }}
                    >
                      <ChevronRight size={20} />
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Botões de cima (flutuam sobre a foto; o toque passa para a foto onde não há botão) */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                zIndex: 2,
                pointerEvents: "none",
                opacity: viewerUiVisible ? 1 : 0,
                transition: "opacity 0.2s ease",
                background: "linear-gradient(to bottom, rgba(0,0,0,0.65), rgba(0,0,0,0))",
                paddingTop: viewerLandscape ? "calc(4px + env(safe-area-inset-top))" : "calc(12px + env(safe-area-inset-top))",
                paddingBottom: 14,
                paddingLeft: "calc(12px + env(safe-area-inset-left))",
                paddingRight: "calc(12px + env(safe-area-inset-right))",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: 8, pointerEvents: viewerUiVisible ? "auto" : "none" }} onClick={(e) => e.stopPropagation()}>
                <span style={{ color: "#FFF", fontWeight: 700, fontSize: 14, background: viewerPillBg, borderRadius: 999, padding: "6px 12px", boxShadow: "0 1px 4px rgba(0,0,0,0.45)" }}>
                  🔍 Ver ampliado
                  {noteImages.length > 1 && (
                    <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: 400, marginLeft: 8 }}>{viewIndex + 1}/{noteImages.length}</span>
                  )}
                </span>
                {viewerLandscape && viewerZoomControls}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); fillViewerScreen(); }}
                    style={viewerIconBtn}
                    title={viewZoom > 1.01 ? "Ajustar à tela" : "Preencher a tela"}
                    aria-label={viewZoom > 1.01 ? "Ajustar à tela" : "Preencher a tela"}
                  >
                    {viewZoom > 1.01 ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewerShareOrDownload(); }}
                    style={viewerIconBtn}
                    title="Baixar / Compartilhar"
                  >
                    <Download size={20} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleViewerRotate(); }}
                    style={viewerIconBtn}
                    title="Girar"
                  >
                    <RotateCw size={20} />
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setViewingImage(null); }}
                    style={viewerIconBtn}
                    title="Fechar"
                  >
                    <X size={22} />
                  </button>
                </div>
              </div>
            </div>

            {/* Zoom de baixo (só com o celular em pé; na horizontal o zoom fica em cima) */}
            {!viewerLandscape && (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  zIndex: 2,
                  pointerEvents: "none",
                  opacity: viewerUiVisible ? 1 : 0,
                  transition: "opacity 0.2s ease",
                  background: "linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))",
                  padding: "14px 16px calc(10px + env(safe-area-inset-bottom))",
                }}
              >
                <div style={{ pointerEvents: viewerUiVisible ? "auto" : "none" }} onClick={(e) => e.stopPropagation()}>
                  {viewerZoomControls}
                </div>
              </div>
            )}
          </div>,
          document.body
        )}

        {/* Leitura acompanhada — palavra destacada enquanto a voz lê */}
        {readDoc && (
          <ReadAlongView
            doc={readDoc}
            speech={speech}
            storageKey={editingNote?.id ? `readalong_pos_${editingNote.id}` : null}
            theme={theme}
            isDark={isDark}
            textColor={textColor}
            fontSize={editorFontSize}
            resumedFrom={readResumedFrom}
            onClose={closeReadAlong}
          />
        )}

        {/* Modo de leitura simplificado — tela limpa, só o texto, bem grande */}
        {readingMode && (
          <div
            className="absolute inset-0 z-[90] flex flex-col"
            style={{ background: highContrast ? (isDark ? "#000" : "#FFF") : theme.bg }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", paddingTop: "calc(14px + env(safe-area-inset-top))", borderBottom: `1px solid ${theme.lines}`, flexShrink: 0 }}>
              <button onClick={() => setReadingMode(false)} style={{ background: "none", border: "none", color: textColor, display: "flex", alignItems: "center", gap: 6, fontSize: 14, fontWeight: 600 }}>
                <X size={20} /> Fechar
              </button>
              <button
                onClick={() => setSelectedColor(selectedColor === "bg-gray-800" ? lastLightColorRef.current : "bg-gray-800")}
                title={selectedColor === "bg-gray-800" ? "Modo claro" : "Modo noturno"}
                aria-label={selectedColor === "bg-gray-800" ? "Modo claro" : "Modo noturno"}
                style={{
                  width: 40, height: 40, borderRadius: "50%", flexShrink: 0,
                  background: selectedColor === "bg-gray-800" ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)",
                  border: `1px solid ${theme.lines}`, color: textColor,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {selectedColor === "bg-gray-800" ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                )}
              </button>
              <button
                onClick={toggleReadAloud}
                style={{ background: isSpeaking ? theme.borderAccent : "transparent", border: `1px solid ${theme.lines}`, borderRadius: 10, padding: "8px 14px", color: isSpeaking ? "#FFF" : textColor, display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}
              >
                {isSpeaking ? <VolumeX size={16} /> : <Volume2 size={16} />} {isSpeaking ? "Parar" : "Ouvir"}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-6" style={{ touchAction: "pan-y", WebkitOverflowScrolling: "touch", overscrollBehavior: "contain" }}>
              {title.trim() && (
                <h1 style={{ fontSize: Math.max(28, editorFontSize * 1.4), fontWeight: 700, color: textColor, marginBottom: 20, lineHeight: 1.3 }}>
                  {title}
                </h1>
              )}
              {blocks.map((b, i) => {
                if (b.type === "text" && b.content?.trim()) {
                  return (
                    <div
                      key={i}
                      style={{
                        fontSize: Math.max(20, editorFontSize * 1.15),
                        lineHeight: 1.8,
                        color: b.style?.color || textColor,
                        fontWeight: b.style?.bold ? 700 : 400,
                        textAlign: b.style?.align || "left",
                        marginBottom: 16,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {consistentHtml(b) ? <span className="note-rich-view" dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(consistentHtml(b)!) }} /> : b.content}
                    </div>
                  );
                }
                if (b.type === "checklist" && b.items) {
                  return (
                    <div key={i} style={{ marginBottom: 16, width: "100%", maxWidth: "100%", overflow: "hidden" }}>
                      {b.items.map((it) => (
                        <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", fontSize: Math.max(18, editorFontSize), color: textColor, opacity: it.checked ? 0.6 : 1, fontWeight: it.bold ? 700 : 400 }}>
                          {it.checked ? <CheckSquare size={22} color="#4CAF50" /> : <Square size={22} />}
                          <span style={{ textDecoration: it.checked ? "line-through" : "none", minWidth: 0, overflowWrap: "break-word" }}>{it.text}</span>
                        </div>
                      ))}
                    </div>
                  );
                }
                if (b.type === "table" && b.tableItems) {
                  return (
                    <div key={i} style={{ marginBottom: 16, width: "100%", maxWidth: "100%", overflow: "hidden" }}>
                      {b.tableItems.map((it) => (
                        <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "8px 0", fontSize: Math.max(18, editorFontSize), color: textColor, borderBottom: `1px solid ${theme.lines}` }}>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.nome}</span>
                          <strong style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{valorParaExibir(it.valor, false)}</strong>
                        </div>
                      ))}
                    </div>
                  );
                }
                if (b.type === "image" && b.url) {
                  return <img key={i} src={b.url} alt="" style={{ width: "100%", borderRadius: 12, marginBottom: 16 }} />;
                }
                return null;
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
