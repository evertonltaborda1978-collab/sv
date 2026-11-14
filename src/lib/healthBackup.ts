import { getHealthFileBlob, shareFiles, type HealthFile } from "./healthFiles";
import { flushQueue } from "./healthVisits";

// Backup e restauração da área de Saúde (consultas, atestados/anexos, remédios e horários).
// O backup é um único arquivo .json, que você guarda no Google Drive, e-mail ou WhatsApp.
// Restaurar só ADICIONA o que está faltando (ou o que for mais novo): nunca apaga o que já existe.

const BACKUP_APP = "sv-saude-backup";
const BACKUP_VERSION = 1;

// Mesmo "cofre" de arquivos usado em healthFiles.ts
const CACHE_NAME = "health-files-v1";
const cacheUrl = (path: string) => `${location.origin}/__health__/${path}`;

const lastKey = (uid: string) => `sv_health_backup_last_${uid}`;

export interface BackupStats {
  visits: number;
  meds: number;
  files: number;
  missingFiles: string[];
}

export interface RestoreStats {
  visits: number;
  meds: number;
  files: number;
}

// ── Quais dados do aparelho entram no backup ──────────
function isBackupKey(key: string, uid: string): boolean {
  if (!key.includes(uid)) return false;
  if (key.startsWith("health_queue_")) return false; // fila de envio: é refeita ao restaurar
  if (key.includes("lock")) return false; // nada de senha/bloqueio no arquivo
  if (key.includes("backup")) return false;
  return key.startsWith("health_") || key.startsWith("medications_") || key.startsWith("profiles_");
}

function collectStorage(uid: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !isBackupKey(k, uid)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
  } catch {}
  return out;
}

function parse<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

const arr = (x: any): any[] => (Array.isArray(x) ? x : []);

/** Todos os anexos de um atendimento (receitas, exames, resultados, encaminhamentos e procedimentos). */
function rawVisitFiles(v: any): HealthFile[] {
  return [
    ...arr(v?.prescriptions).flatMap((p: any) => arr(p?.files)),
    ...arr(v?.exams).flatMap((e: any) => [...arr(e?.files), ...arr(e?.resultFiles)]),
    ...arr(v?.referrals).flatMap((r: any) => arr(r?.files)),
    ...arr(v?.procedures).flatMap((p: any) => arr(p?.files)),
  ].filter((f: any) => f && typeof f.path === "string");
}

function markFilesPending(v: any): void {
  for (const f of rawVisitFiles(v)) (f as any).pending = true;
}

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

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// ── Exportar ──────────────────────────────────────────
export async function buildBackup(uid: string): Promise<{ blob: Blob; name: string; stats: BackupStats }> {
  const storage = collectStorage(uid);
  const visits = parse<any[]>(storage[`health_visits_${uid}`], []);
  const meds = parse<any[]>(storage[`medications_${uid}`], []);

  const unique = new Map<string, HealthFile>();
  for (const v of visits) for (const f of rawVisitFiles(v)) unique.set(f.path, f);

  const parts: BlobPart[] = [];
  parts.push(
    `{"app":${JSON.stringify(BACKUP_APP)},"version":${BACKUP_VERSION},"uid":${JSON.stringify(uid)},` +
      `"created_at":${JSON.stringify(new Date().toISOString())},"storage":${JSON.stringify(storage)},"files":[`
  );

  const missingFiles: string[] = [];
  let included = 0;
  for (const f of unique.values()) {
    try {
      const blob = await getHealthFileBlob(f);
      const data = await blobToBase64(blob);
      parts.push(
        (included > 0 ? "," : "") +
          `{"path":${JSON.stringify(f.path)},"type":${JSON.stringify(f.type || blob.type || "")},"name":${JSON.stringify(f.name || "")},"data":"${data}"}`
      );
      included++;
    } catch {
      missingFiles.push(f.name || f.path);
    }
  }
  parts.push("]}");

  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `backup-saude-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
  try {
    localStorage.setItem(lastKey(uid), d.toISOString());
  } catch {}

  return {
    blob: new Blob(parts, { type: "application/json" }),
    name,
    stats: { visits: visits.length, meds: meds.length, files: included, missingFiles },
  };
}

export function shareBackup(blob: Blob, name: string) {
  return shareFiles([{ blob, name }], "Backup da Saúde");
}

export function lastBackupAt(uid: string): Date | null {
  try {
    const v = localStorage.getItem(lastKey(uid));
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ── Restaurar ─────────────────────────────────────────
function mergeById(local: any[], incoming: any[]): { list: any[]; added: any[] } {
  const ids = new Set(local.map((x) => x?.id));
  const added = incoming.filter((x) => x && x.id && !ids.has(x.id));
  return { list: [...local, ...added], added };
}

async function cachePutRaw(path: string, blob: Blob): Promise<void> {
  try {
    if (!("caches" in window)) return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      cacheUrl(path),
      new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } })
    );
  } catch {}
}

export async function restoreBackup(uid: string, file: File): Promise<RestoreStats> {
  let data: any;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("Este arquivo não é um backup válido.");
  }
  if (!data || data.app !== BACKUP_APP || typeof data.storage !== "object" || data.storage === null) {
    throw new Error("Este arquivo não é um backup da Saúde.");
  }
  if (data.uid !== uid) {
    throw new Error("Este backup é de outra conta. Entre com a conta que gerou o backup.");
  }

  const stats: RestoreStats = { visits: 0, meds: 0, files: 0 };
  const storage = data.storage as Record<string, string>;
  const set = (k: string, v: unknown) => {
    try {
      localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    } catch {}
  };

  const visitsKey = `health_visits_${uid}`;
  const queueKey = `health_queue_${uid}`;
  const medsKey = `medications_${uid}`;
  const trashKey = `medications_trash_${uid}`;
  const profilesKey = `profiles_${uid}`;
  const dirKey = `health_dir_${uid}`;

  // Consultas: entra o que falta e o que estiver mais novo no backup
  if (storage[visitsKey]) {
    const local = parse<any[]>(localStorage.getItem(visitsKey), []);
    const incoming = parse<any[]>(storage[visitsKey], []);
    const byId = new Map<string, any>(local.map((v) => [v.id, v]));
    const touched: string[] = [];
    for (const v of incoming) {
      if (!v || !v.id) continue;
      const cur = byId.get(v.id);
      if (!cur || String(v.updated_at || "") > String(cur.updated_at || "")) {
        markFilesPending(v); // os anexos sobem de novo para a nuvem
        byId.set(v.id, v);
        touched.push(v.id);
      }
    }
    set(visitsKey, [...byId.values()]);
    if (touched.length) {
      const queue = parse<any[]>(localStorage.getItem(queueKey), []).filter((o) => !touched.includes(o?.id));
      set(queueKey, [...queue, ...touched.map((id) => ({ type: "upsert", id }))]);
    }
    stats.visits = touched.length;
  }

  // Remédios, lixeira e perfis: entra só o que falta
  if (storage[medsKey]) {
    const m = mergeById(parse<any[]>(localStorage.getItem(medsKey), []), parse<any[]>(storage[medsKey], []));
    set(medsKey, m.list);
    stats.meds = m.added.length;
  }
  if (storage[trashKey]) {
    set(trashKey, mergeById(parse<any[]>(localStorage.getItem(trashKey), []), parse<any[]>(storage[trashKey], [])).list);
  }
  if (storage[profilesKey]) {
    set(profilesKey, mergeById(parse<any[]>(localStorage.getItem(profilesKey), []), parse<any[]>(storage[profilesKey], [])).list);
  }

  // Lista de locais e médicos
  if (storage[dirKey]) {
    const loc = parse<any>(localStorage.getItem(dirKey), {});
    const inc = parse<any>(storage[dirKey], {});
    set(dirKey, {
      places: mergeById(arr(loc.places), arr(inc.places)).list,
      doctors: mergeById(arr(loc.doctors), arr(inc.doctors)).list,
    });
  }

  // Qualquer outra chave de Saúde: só entra se não existir
  const handled = new Set([visitsKey, queueKey, medsKey, trashKey, profilesKey, dirKey]);
  for (const [k, v] of Object.entries(storage)) {
    if (handled.has(k) || !isBackupKey(k, uid)) continue;
    try {
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    } catch {}
  }

  // Anexos: voltam para o cofre do aparelho
  for (const f of arr(data.files)) {
    if (!f || typeof f.path !== "string" || typeof f.data !== "string") continue;
    if (!f.path.startsWith(`${uid}/`)) continue; // só arquivos desta conta
    try {
      await cachePutRaw(f.path, base64ToBlob(f.data, f.type || "application/octet-stream"));
      stats.files++;
    } catch {}
  }

  try {
    window.dispatchEvent(new Event("medications-changed"));
  } catch {}
  try {
    await flushQueue(uid);
  } catch {}

  return stats;
}
