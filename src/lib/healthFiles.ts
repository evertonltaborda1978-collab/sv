import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { supabase } from "@/integrations/supabase/client";

// Arquivos da aba Saúde (fotos e PDFs de receitas, mais tarde exames).
// - Ficam num "bucket" PRIVADO do Supabase, dentro de uma pasta com o id de
//   quem enviou (só a própria conta lê).
// - Cada arquivo também fica guardado no aparelho (Cache API), então o que já
//   foi aberto ou anexado abre sem internet.
// - Fotos são reduzidas antes de subir (poupa a cota do Supabase).

export const HEALTH_BUCKET = "health-files";
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB por arquivo
export const MAX_FILES_PER_PRESCRIPTION = 12;

export interface HealthFile {
  id: string;
  path: string;
  name: string;
  type: string; // "image/jpeg" | "application/pdf"
  size: number;
  /** true = ainda não subiu para a nuvem (estava sem internet) */
  pending?: boolean;
}

// ── Cópia no aparelho ─────────────────────────────────
const CACHE_NAME = "health-files-v1";
const cacheUrl = (path: string) => `${location.origin}/__health__/${path}`;

async function cachePut(path: string, blob: Blob): Promise<void> {
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      cacheUrl(path),
      new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } })
    );
  } catch {}
}

async function cacheGet(path: string): Promise<Blob | null> {
  try {
    if (!("caches" in window)) return null;
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(cacheUrl(path));
    return res ? await res.blob() : null;
  } catch {
    return null;
  }
}

async function cacheDelete(path: string): Promise<void> {
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(cacheUrl(path));
  } catch {}
}

// ── Foto: reduz e converte para JPEG ──────────────────
export async function compressImage(file: Blob, maxDim = 2000, quality = 0.78): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Imagem inválida"));
      i.src = url;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Sem canvas");
    ctx.fillStyle = "#ffffff"; // PNG com fundo transparente vira fundo branco
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
    if (!out) throw new Error("Falha ao reduzir a foto");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Enviar / baixar / apagar ──────────────────────────
async function uploadBlob(path: string, blob: Blob, type: string): Promise<boolean> {
  try {
    const { error } = await supabase.storage.from(HEALTH_BUCKET).upload(path, blob, { contentType: type, upsert: true });
    return !error;
  } catch {
    return false;
  }
}

/** Guarda no aparelho e tenta subir; sem internet, fica marcado como "pending" e sobe depois. */
export async function storeHealthFile(userId: string, blob: Blob, name: string, type: string): Promise<HealthFile> {
  const id = crypto.randomUUID();
  const ext = type === "application/pdf" ? "pdf" : "jpg";
  const path = `${userId}/${id}.${ext}`;
  await cachePut(path, blob);
  const file: HealthFile = { id, path, name, type, size: blob.size };
  const ok = await uploadBlob(path, blob, type);
  if (!ok) file.pending = true;
  return file;
}

export async function syncPendingFile(file: HealthFile): Promise<boolean> {
  const blob = await cacheGet(file.path);
  if (!blob) return false;
  return uploadBlob(file.path, blob, file.type);
}

/** Abre pelo aparelho se já tiver; senão baixa da nuvem (e guarda para a próxima vez). */
export async function getHealthFileBlob(file: HealthFile): Promise<Blob> {
  const cached = await cacheGet(file.path);
  if (cached) return cached;
  const { data, error } = await supabase.storage.from(HEALTH_BUCKET).download(file.path);
  if (error || !data) throw new Error("Arquivo indisponível sem internet");
  await cachePut(file.path, data);
  return data;
}

export async function deleteHealthFiles(files: HealthFile[]): Promise<void> {
  if (!files.length) return;
  try {
    await supabase.storage.from(HEALTH_BUCKET).remove(files.map((f) => f.path));
  } catch {}
  for (const f of files) await cacheDelete(f.path);
}

// ── Compartilhar (WhatsApp, e-mail...) ────────────────
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const safeName = (n: string) => n.replace(/[^\w.\-]+/g, "_");

export async function shareFiles(items: { blob: Blob; name: string }[], title: string): Promise<"shared" | "saved" | "failed"> {
  if (!items.length) return "failed";

  if (Capacitor.isNativePlatform()) {
    try {
      const uris: string[] = [];
      let i = 0;
      for (const it of items) {
        const data = await blobToBase64(it.blob);
        const written = await Filesystem.writeFile({
          path: `saude-${Date.now()}-${i++}-${safeName(it.name)}`,
          data,
          directory: Directory.Cache,
        });
        uris.push(written.uri);
      }
      await Share.share({ files: uris, title, dialogTitle: title });
      return "shared";
    } catch (err: any) {
      if (err?.message?.toLowerCase?.().includes("cancel")) return "shared";
      return "failed";
    }
  }

  try {
    const files = items.map((it) => new File([it.blob], it.name, { type: it.blob.type }));
    const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean };
    if (nav.share && nav.canShare && nav.canShare({ files })) {
      await nav.share({ files, title });
      return "shared";
    }
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    return "saved";
  } catch (err: any) {
    if (err?.name === "AbortError") return "shared";
    return "failed";
  }
}

// ── Juntar fotos em um PDF (sem biblioteca externa) ───
export interface PdfImage {
  bytes: Uint8Array; // JPEG
  w: number;
  h: number;
}

/** Monta um PDF simples: 1 página por foto JPEG, cada página do tamanho da foto (maior lado = 842 pt). */
export function buildPdfFromJpegs(images: PdfImage[]): Blob {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (data: Uint8Array | string) => {
    const b = typeof data === "string" ? enc.encode(data) : data;
    chunks.push(b);
    pos += b.length;
  };
  const begin = (num: number) => {
    offsets[num] = pos;
    push(`${num} 0 obj\n`);
  };
  const end = () => push("\nendobj\n");
  const n = images.length;

  push("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");

  begin(1);
  push("<< /Type /Catalog /Pages 2 0 R >>");
  end();

  const kids = images.map((_, k) => `${3 + 3 * k} 0 R`).join(" ");
  begin(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  end();

  images.forEach((img, k) => {
    const pageNum = 3 + 3 * k;
    const contentNum = 4 + 3 * k;
    const imageNum = 5 + 3 * k;
    const s = 842 / Math.max(img.w, img.h);
    const pw = Math.round(img.w * s * 100) / 100;
    const ph = Math.round(img.h * s * 100) / 100;

    begin(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ` +
        `/Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    end();

    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    begin(contentNum);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    end();

    begin(imageNum);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`
    );
    push(img.bytes);
    push("\nendstream");
    end();
  });

  const xrefPos = pos;
  const total = 3 + 3 * n;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new Blob(chunks as unknown as BlobPart[], { type: "application/pdf" });
}

function imageSize(blob: Blob): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => {
      resolve({ w: i.naturalWidth, h: i.naturalHeight });
      URL.revokeObjectURL(url);
    };
    i.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Imagem inválida"));
    };
    i.src = url;
  });
}

/** As fotos guardadas já são JPEG (a conversão acontece ao anexar). */
export async function imagesToPdf(blobs: Blob[]): Promise<Blob> {
  const imgs: PdfImage[] = [];
  for (const b of blobs) {
    const { w, h } = await imageSize(b);
    imgs.push({ bytes: new Uint8Array(await b.arrayBuffer()), w, h });
  }
  return buildPdfFromJpegs(imgs);
}

// ── Girar a foto 90° (para a receita fotografada de lado) ──
export async function rotateImage90(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Imagem inválida"));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalHeight;
    canvas.height = img.naturalWidth;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Sem canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, 0, 0);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.85));
    if (!out) throw new Error("Falha ao girar a foto");
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Abrir o arquivo no leitor do celular (PDF) ──
const FileOpener = registerPlugin<{ open(o: { path: string; mimeType?: string }): Promise<void> }>("FileOpener");

/** "aberto" = abriu; "sem-leitor" = não há app de PDF; "falhou" = não deu (ex.: APK antigo, sem o plugin). */
export async function abrirArquivo(blob: Blob, name: string): Promise<"aberto" | "sem-leitor" | "falhou"> {
  if (!Capacitor.isNativePlatform()) {
    window.open(URL.createObjectURL(blob), "_blank");
    return "aberto";
  }
  try {
    const data = await blobToBase64(blob);
    const written = await Filesystem.writeFile({
      path: `abrir-${Date.now()}-${safeName(name)}`,
      data,
      directory: Directory.Cache,
    });
    await FileOpener.open({ path: written.uri, mimeType: blob.type || "application/pdf" });
    return "aberto";
  } catch (err: any) {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("nenhum aplicativo") ? "sem-leitor" : "falhou";
  }
}
