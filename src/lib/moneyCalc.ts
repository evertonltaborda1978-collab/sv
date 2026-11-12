/**
 * Dinheiro (R$) e calculadora de expressões, sem usar eval().
 * Aceita: + - * / ( ) e também × ÷ −, com ponto ou vírgula decimal.
 */

const BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

/** 100.49 -> "R$ 100,49" */
export function formatBRL(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return BRL.format(value).replace(/\u00a0/g, " ");
}

/**
 * Máscara de centavos: o usuário digita só números e o valor "cresce"
 * da direita para a esquerda (1 -> 0,01 | 10049 -> 100,49).
 * Retorna null quando o campo fica vazio ou zerado.
 */
export function parseCentsInput(raw: string): number | null {
  const digits = raw.replace(/\D/g, "").slice(0, 12);
  if (!digits) return null;
  const cents = parseInt(digits, 10);
  if (cents === 0) return null;
  return cents / 100;
}

function parseNumberToken(token: string): number | null {
  let s = token;
  if (s.includes(",") && s.includes(".")) {
    // 1.234,56 -> 1234.56
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

type Tok = number | string;

/** Avalia a expressão. Retorna null se for inválida. Resultado arredondado a centavos. */
export function evaluateExpression(input: string): number | null {
  const src = input
    .replace(/−/g, "-")
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/R\$/gi, "")
    .replace(/\s+/g, "");
  if (!src || src.length > 200) return null;

  const tokens: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/[0-9.,]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.,]/.test(src[j])) j++;
      const n = parseNumberToken(src.slice(i, j));
      if (n === null) return null;
      tokens.push(n);
      i = j;
    } else if ("+-*/()".includes(ch)) {
      tokens.push(ch);
      i++;
    } else {
      return null;
    }
  }

  let pos = 0;

  const parseFactor = (): number | null => {
    const t = tokens[pos];
    if (t === "-") {
      pos++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (t === "+") {
      pos++;
      return parseFactor();
    }
    if (t === "(") {
      pos++;
      const v = parseExpr();
      if (v === null || tokens[pos] !== ")") return null;
      pos++;
      return v;
    }
    if (typeof t === "number") {
      pos++;
      return t;
    }
    return null;
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (tokens[pos] === "*" || tokens[pos] === "/") {
      const op = tokens[pos++];
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  };

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (tokens[pos] === "+" || tokens[pos] === "-") {
      const op = tokens[pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  const result = parseExpr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
    return null;
  }
  return Math.round(result * 100) / 100;
}
