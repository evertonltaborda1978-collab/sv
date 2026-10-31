import { supabase } from "@/integrations/supabase/client";
import { HealthFile, deleteHealthFiles, syncPendingFile } from "./healthFiles";

// Atendimentos (consultas) e receitas. Funciona assim:
// 1) Tudo é salvo primeiro NO APARELHO (funciona sem internet).
// 2) Cada alteração entra numa fila e é enviada ao Supabase quando houver internet.
// 3) Ao abrir a área (ou quando a internet volta) o app envia a fila e baixa a lista.
//    Sem atualização automática de tempos em tempos — poupa a cota de tráfego.

export const PLACE_TYPES = ["UPA", "Hospital", "Clínica", "Posto de saúde", "Particular", "Outro"] as const;

// Opções para tocar (em vez de digitar) ao cadastrar o remédio da receita
export const RX_UNITS = ["mg", "g", "mcg", "ml", "gotas", "UI", "%"] as const;
export const RX_FORMS = ["Caixa", "Envelope", "Cartela", "Frasco", "Tubo", "Ampola", "Unidade", "Outro"] as const;

// Opções para tocar em "Quantidade total" e "Como tomar"
export const RX_TOTAL_UNITS = ["comprimidos", "cápsulas", "ml", "g", "unidades"] as const;
export const RX_DOSE_UNITS = ["comprimido", "cápsula", "gota", "ml", "aplicação", "sachê"] as const;
export const RX_VIAS = ["oral", "tópica", "sublingual", "injetável", "outra"] as const;

export interface RxItem {
  id: string;
  name: string; // ex.: "Amoxicilina"
  strength?: string; // ex.: "500"
  unit?: string; // ex.: "mg", "gotas"
  form?: string; // ex.: "Caixa", "Envelope"
  amount?: number; // quantas embalagens (ex.: 2)
  qty: string; // observação livre (ex.: "21 cápsulas; 1 a cada 8 horas")
  bought: boolean;
  totalQty?: string; // quantidade total (ex.: "21")
  totalUnit?: string; // ex.: "comprimidos"
  doseQty?: string; // quanto tomar por vez (ex.: "3")
  doseUnit?: string; // ex.: "comprimido"
  via?: string; // ex.: "oral"
  vezesDia?: number; // ex.: 1 (vez ao dia)
}

export interface Prescription {
  id: string;
  title: string;
  notes: string;
  items: RxItem[];
  files: HealthFile[];
}

export const EXAM_STATUS = ["Pedido", "Agendado", "Realizado"] as const;
export const REFERRAL_STATUS = ["Pendente", "Agendado", "Consultado"] as const;

/** Pedido de exame: o pedido do médico (files) e, depois, o resultado (resultFiles). */
export interface Exam {
  id: string;
  name: string; // ex.: "Raio-X do joelho"
  place: string; // laboratório ou clínica
  status: string;
  date: string; // YYYY-MM-DD (agendada ou feita) ou ""
  notes: string;
  files: HealthFile[];
  resultFiles: HealthFile[];
}

/** Encaminhamento para outro médico ou especialidade. */
export interface Referral {
  id: string;
  to: string; // especialidade ou médico
  place: string;
  status: string;
  date: string;
  notes: string;
  files: HealthFile[];
}

/** Outros procedimentos (curativo, retirada de pontos, imobilização...). */
export interface Procedure {
  id: string;
  name: string;
  place: string;
  date: string;
  notes: string;
  files: HealthFile[];
}

export interface HealthVisit {
  id: string;
  visit_date: string; // YYYY-MM-DD
  place_type: string;
  place_name: string;
  doctor_name: string;
  doctor_crm: string;
  reason: string;
  notes: string;
  prescriptions: Prescription[];
  exams: Exam[];
  referrals: Referral[];
  procedures: Procedure[];
  updated_at: string;
}

type Op = { type: "upsert" | "delete"; id: string };

const TABLE = "health_visits";
const dataKey = (uid: string) => `health_visits_${uid}`;
const queueKey = (uid: string) => `health_queue_${uid}`;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function sortVisits(list: HealthVisit[]): HealthVisit[] {
  return [...list].sort(
    (a, b) => b.visit_date.localeCompare(a.visit_date) || (b.updated_at || "").localeCompare(a.updated_at || "")
  );
}

const arr = (x: any): any[] => (Array.isArray(x) ? x : []);

/** Garante todos os campos (atendimentos salvos em versões antigas não tinham exames etc.). */
export function normalizeVisit(v: any): HealthVisit {
  return {
    id: v.id,
    visit_date: String(v.visit_date || "").slice(0, 10),
    place_type: v.place_type || "",
    place_name: v.place_name || "",
    doctor_name: v.doctor_name || "",
    doctor_crm: v.doctor_crm || "",
    reason: v.reason || "",
    notes: v.notes || "",
    prescriptions: arr(v.prescriptions).map((p: any) => ({ ...p, items: arr(p.items), files: arr(p.files) })),
    exams: arr(v.exams).map((e: any) => ({
      id: e.id, name: e.name || "", place: e.place || "", status: e.status || "Pedido", date: e.date || "",
      notes: e.notes || "", files: arr(e.files), resultFiles: arr(e.resultFiles),
    })),
    referrals: arr(v.referrals).map((r: any) => ({
      id: r.id, to: r.to || "", place: r.place || "", status: r.status || "Pendente", date: r.date || "",
      notes: r.notes || "", files: arr(r.files),
    })),
    procedures: arr(v.procedures).map((p: any) => ({
      id: p.id, name: p.name || "", place: p.place || "", date: p.date || "", notes: p.notes || "", files: arr(p.files),
    })),
    updated_at: v.updated_at || "",
  };
}

/** Todos os arquivos de um atendimento (receitas, exames, encaminhamentos e procedimentos). */
export function allVisitFiles(v: HealthVisit): HealthFile[] {
  return [
    ...v.prescriptions.flatMap((p) => p.files),
    ...v.exams.flatMap((e) => [...e.files, ...e.resultFiles]),
    ...v.referrals.flatMap((r) => r.files),
    ...v.procedures.flatMap((p) => p.files),
  ];
}

export function loadLocalVisits(uid: string): HealthVisit[] {
  return sortVisits(readJson<any[]>(dataKey(uid), []).map(normalizeVisit));
}

function saveLocalVisits(uid: string, list: HealthVisit[]): void {
  writeJson(dataKey(uid), sortVisits(list));
}

function loadQueue(uid: string): Op[] {
  return readJson<Op[]>(queueKey(uid), []);
}

function saveQueue(uid: string, q: Op[]): void {
  writeJson(queueKey(uid), q);
}

function enqueue(uid: string, op: Op): void {
  saveQueue(uid, [...loadQueue(uid).filter((o) => o.id !== op.id), op]);
}

export function pendingCount(uid: string): number {
  return loadQueue(uid).length;
}

function toRow(uid: string, v: HealthVisit) {
  return {
    id: v.id,
    user_id: uid,
    visit_date: v.visit_date,
    place_type: v.place_type,
    place_name: v.place_name,
    doctor_name: v.doctor_name,
    doctor_crm: v.doctor_crm,
    reason: v.reason,
    notes: v.notes,
    prescriptions: v.prescriptions,
    exams: v.exams,
    referrals: v.referrals,
    procedures: v.procedures,
    updated_at: v.updated_at,
  };
}

function fromRow(r: any): HealthVisit {
  return normalizeVisit(r);
}

let flushing = false;

/** Envia a fila para a nuvem. Devolve true se não sobrou nada pendente. */
export async function flushQueue(uid: string): Promise<boolean> {
  if (flushing) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return loadQueue(uid).length === 0;
  flushing = true;
  try {
    for (const op of [...loadQueue(uid)]) {
      let done = false;
      try {
        if (op.type === "delete") {
          const { error } = await (supabase as any).from(TABLE).delete().eq("id", op.id).eq("user_id", uid);
          if (error) break;
          done = true;
        } else {
          const all = loadLocalVisits(uid);
          const visit = all.find((v) => v.id === op.id);
          if (!visit) {
            done = true; // foi apagado depois; nada a enviar
          } else {
            // sobe antes os arquivos que ficaram esperando internet
            let stillPending = false;
            for (const f of allVisitFiles(visit)) {
              if (f.pending) {
                if (await syncPendingFile(f)) f.pending = false;
                else stillPending = true;
              }
            }
            saveLocalVisits(uid, all.map((v) => (v.id === visit.id ? visit : v)));
            const { error } = await (supabase as any).from(TABLE).upsert(toRow(uid, visit));
            if (error) break;
            done = !stillPending; // se algum arquivo não subiu, tenta de novo depois
          }
        }
      } catch {
        break;
      }
      if (done) saveQueue(uid, loadQueue(uid).filter((o) => !(o.id === op.id && o.type === op.type)));
    }
  } finally {
    flushing = false;
  }
  return loadQueue(uid).length === 0;
}

/** Salva no aparelho na hora e tenta enviar para a nuvem. */
export async function saveVisit(uid: string, visit: HealthVisit): Promise<HealthVisit[]> {
  const v: HealthVisit = { ...visit, updated_at: new Date().toISOString() };
  saveLocalVisits(uid, [...loadLocalVisits(uid).filter((x) => x.id !== v.id), v]);
  enqueue(uid, { type: "upsert", id: v.id });
  await flushQueue(uid);
  return loadLocalVisits(uid);
}

export async function removeVisit(uid: string, id: string): Promise<HealthVisit[]> {
  const all = loadLocalVisits(uid);
  const v = all.find((x) => x.id === id);
  saveLocalVisits(uid, all.filter((x) => x.id !== id));
  enqueue(uid, { type: "delete", id });
  if (v) await deleteHealthFiles(allVisitFiles(v));
  await flushQueue(uid);
  return loadLocalVisits(uid);
}

/** Envia o que estiver na fila e baixa a lista da nuvem. */
export async function refreshVisits(uid: string): Promise<{ visits: HealthVisit[]; synced: boolean }> {
  await flushQueue(uid);
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("offline");
    const { data, error } = await (supabase as any).from(TABLE).select("*").eq("user_id", uid);
    if (error || !data) throw error || new Error("sem dados");
    const queue = loadQueue(uid);
    const pendingIds = new Set(queue.map((o) => o.id));
    const merged: HealthVisit[] = [];
    for (const row of data as any[]) if (!pendingIds.has(row.id)) merged.push(fromRow(row));
    for (const v of loadLocalVisits(uid)) {
      if (queue.some((o) => o.id === v.id && o.type === "upsert")) merged.push(v);
    }
    saveLocalVisits(uid, merged);
    return { visits: loadLocalVisits(uid), synced: queue.length === 0 };
  } catch {
    return { visits: loadLocalVisits(uid), synced: false };
  }
}

// ── Lista de locais e médicos (para escolher nos menus) ──────────────────
export interface DirPlace { id: string; type: string; name: string }
export interface DirDoctor { id: string; name: string; crm: string }
export interface HealthDirectory { places: DirPlace[]; doctors: DirDoctor[] }

const DIR_TABLE = "health_directory";
const dirKey = (uid: string) => `health_dir_${uid}`;
const dirPendingKey = (uid: string) => `health_dir_pending_${uid}`;
const dirSeededKey = (uid: string) => `health_dir_seeded_${uid}`;

export function loadDirectory(uid: string): HealthDirectory {
  const d = readJson<Partial<HealthDirectory>>(dirKey(uid), {});
  return { places: Array.isArray(d.places) ? d.places : [], doctors: Array.isArray(d.doctors) ? d.doctors : [] };
}

async function pushDirectory(uid: string, dir: HealthDirectory): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const { error } = await (supabase as any)
      .from(DIR_TABLE)
      .upsert({ user_id: uid, places: dir.places, doctors: dir.doctors, updated_at: new Date().toISOString() });
    return !error;
  } catch {
    return false;
  }
}

/** Guarda no aparelho na hora e tenta enviar para a nuvem. */
export async function saveDirectory(uid: string, dir: HealthDirectory): Promise<void> {
  writeJson(dirKey(uid), dir);
  writeJson(dirPendingKey(uid), true);
  if (await pushDirectory(uid, dir)) writeJson(dirPendingKey(uid), false);
}

const norm = (t: string) => t.trim().toLowerCase();

/**
 * Atualiza a lista com a nuvem. Na primeira vez, se estiver vazia, já traz os médicos e locais
 * dos atendimentos que você tinha salvo.
 */
export async function refreshDirectory(uid: string, visits: HealthVisit[]): Promise<HealthDirectory> {
  let dir = loadDirectory(uid);
  const pending = readJson<boolean>(dirPendingKey(uid), false);
  if (pending) {
    if (await pushDirectory(uid, dir)) writeJson(dirPendingKey(uid), false);
  } else if (!(typeof navigator !== "undefined" && navigator.onLine === false)) {
    try {
      const { data, error } = await (supabase as any).from(DIR_TABLE).select("places, doctors").eq("user_id", uid).maybeSingle();
      if (!error && data) {
        dir = { places: Array.isArray(data.places) ? data.places : [], doctors: Array.isArray(data.doctors) ? data.doctors : [] };
        writeJson(dirKey(uid), dir);
        writeJson(dirSeededKey(uid), true);
      }
    } catch {}
  }

  if (!readJson<boolean>(dirSeededKey(uid), false) && dir.places.length === 0 && dir.doctors.length === 0) {
    const places: DirPlace[] = [];
    const doctors: DirDoctor[] = [];
    for (const v of visits) {
      if (v.place_name.trim() && !places.some((p) => norm(p.name) === norm(v.place_name)))
        places.push({ id: crypto.randomUUID(), type: v.place_type, name: v.place_name.trim() });
      if (v.doctor_name.trim() && !doctors.some((d) => norm(d.name) === norm(v.doctor_name)))
        doctors.push({ id: crypto.randomUUID(), name: v.doctor_name.trim(), crm: (v.doctor_crm || "").trim() });
    }
    writeJson(dirSeededKey(uid), true);
    if (places.length || doctors.length) {
      dir = { places, doctors };
      await saveDirectory(uid, dir);
    }
  }
  return dir;
}
