import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { takeNativePhoto } from "@/lib/native";
import {
  HealthFile, MAX_FILES_PER_PRESCRIPTION, MAX_FILE_BYTES,
  abrirArquivo, compressImage, deleteHealthFiles, getHealthFileBlob, imagesToPdf, rotateImage90, shareFiles, storeHealthFile,
} from "@/lib/healthFiles";
import {
  EXAM_STATUS, Exam, HealthDirectory, HealthVisit, Prescription, Procedure, REFERRAL_STATUS, Referral, RX_DOSE_UNITS, RX_FORMS, RX_TOTAL_UNITS, RX_UNITS, RX_VIAS, RxItem,
  allVisitFiles, loadDirectory, loadLocalVisits, pendingCount, refreshDirectory, refreshVisits, removeVisit, saveDirectory, saveVisit,
} from "@/lib/healthVisits";
import { buildMedPrefill, loadLinkedItemIds, rxTitle, type MedPrefill } from "@/lib/healthLink";
import { LocalField, MedicoField, rotuloCrm } from "./HealthPickers";
import { isUnlocked, lockNow, markUnlocked, touchActivity, unlockWithBiometric, verifyAccountPassword } from "@/lib/healthLock";

const ACCENT = "#1A1A2E";
const GREEN = "#1D9E75";
const RED = "#E24B4A";

const MOTIVOS = ["Dor", "Febre", "Retorno", "Exame de rotina", "Acidente / queda", "Pressão"];

const pad2 = (n: number) => String(n).padStart(2, "0");

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function newVisit(): HealthVisit {
  return {
    id: crypto.randomUUID(),
    visit_date: todayLocal(),
    place_type: "",
    place_name: "",
    doctor_name: "",
    doctor_crm: "",
    reason: "",
    notes: "",
    prescriptions: [],
    exams: [],
    referrals: [],
    procedures: [],
    updated_at: "",
  };
}

function newPrescription(n: number): Prescription {
  return { id: crypto.randomUUID(), title: `Receita ${n}`, notes: "", items: [], files: [] };
}

function newExam(): Exam {
  return { id: crypto.randomUUID(), name: "", place: "", status: "Pedido", date: "", notes: "", files: [], resultFiles: [] };
}

function newReferral(): Referral {
  return { id: crypto.randomUUID(), to: "", place: "", status: "Pendente", date: "", notes: "", files: [] };
}

function newProcedure(): Procedure {
  return { id: crypto.randomUUID(), name: "", place: "", date: "", notes: "", files: [] };
}

function allFiles(v: HealthVisit): HealthFile[] {
  return allVisitFiles(v);
}

/** De onde vem o arquivo anexado: uma receita, o pedido ou o resultado de um exame, etc. */
type FileTarget = { kind: "rx" | "examReq" | "examRes" | "referral" | "procedure"; id: string };

function visitSummary(v: HealthVisit): string {
  const plural = (n: number, one: string, many: string) => (n > 0 ? `${n} ${n === 1 ? one : many}` : "");
  const nFiles = allFiles(v).length;
  return [
    plural(v.prescriptions.length, "receita", "receitas"),
    plural(v.exams.length, "exame", "exames"),
    plural(v.referrals.length, "encaminhamento", "encaminhamentos"),
    plural(v.procedures.length, "procedimento", "procedimentos"),
    plural(nFiles, "arquivo", "arquivos"),
  ].filter(Boolean).join(" · ") || "Sem receitas";
}

const PLURAIS: Record<string, string> = { comprimido: "comprimidos", "cápsula": "cápsulas", gota: "gotas", ml: "ml", "aplicação": "aplicações", "sachê": "sachês" };

function quantUnid(qtd: string | undefined, unid: string | undefined): string {
  if (!qtd) return "";
  const n = parseFloat(qtd.replace(",", "."));
  const u = unid ? (n > 1 ? PLURAIS[unid] ?? unid : unid) : "";
  return `${qtd} ${u}`.trim();
}

/** "3 comprimidos · via oral · 1 vez ao dia" */
function posologiaTexto(it: RxItem): string {
  const partes: string[] = [];
  const dose = quantUnid(it.doseQty, it.doseUnit);
  if (dose) partes.push(dose);
  if (it.via) partes.push(`via ${it.via}`);
  if (it.vezesDia && it.vezesDia > 0) partes.push(`${it.vezesDia} ${it.vezesDia === 1 ? "vez" : "vezes"} ao dia`);
  return partes.join(" · ");
}

function totalTexto(it: RxItem): string {
  return it.totalQty ? `${it.totalQty} ${it.totalUnit || ""}`.trim() : "";
}

function embalagemTxt(it: RxItem): string {
  const amount = it.amount && it.amount > 0 ? it.amount : 0;
  const pack = amount ? `${amount} ${(it.form || "unid.").toLowerCase()}${it.form && amount > 1 ? "s" : ""}` : (it.form || "");
  return [pack, it.qty.trim()].filter(Boolean).join(" · ");
}

function itemSummary(it: RxItem): { title: string; sub: string } {
  return { title: rxTitle(it), sub: [embalagemTxt(it), totalTexto(it), posologiaTexto(it)].filter(Boolean).join(" · ") };
}

/** As duas linhas de cada remédio na lista de atendimentos. */
function linhasRemedio(it: RxItem): { linha1: string; linha2: string } {
  const total = totalTexto(it);
  const emb = embalagemTxt(it);
  const pos = posologiaTexto(it);
  return { linha1: [rxTitle(it), total || emb].filter(Boolean).join(" · "), linha2: pos || (total ? emb : "") };
}

// ── Tela de bloqueio ──────────────────────────────────
function LockGate({ email, fs, onUnlocked }: { email: string | null; fs: (n: number) => number; onUnlocked: () => void }) {
  const native = Capacitor.isNativePlatform();
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showPw, setShowPw] = useState(!native);
  const asked = useRef(false);

  const tryBio = async () => {
    setBusy(true);
    setMsg("");
    const r = await unlockWithBiometric();
    setBusy(false);
    if (r === "ok") { onUnlocked(); return; }
    setShowPw(true);
    setMsg(r === "unavailable"
      ? "A digital não está disponível neste aparelho. Use a senha da conta."
      : "Não foi possível confirmar a digital. Tente de novo ou use a senha da conta.");
  };

  const tryPw = async () => {
    if (!pw || !email) return;
    setBusy(true);
    setMsg("");
    const ok = await verifyAccountPassword(email, pw);
    setBusy(false);
    if (ok) { setPw(""); onUnlocked(); } else setMsg("Senha incorreta (ou sem internet para conferir).");
  };

  useEffect(() => {
    if (native && !asked.current) {
      asked.current = true;
      tryBio();
    }
  }, []);

  return (
    <div style={{ textAlign: "center", padding: "28px 8px" }}>
      <div style={{ fontSize: 46, marginBottom: 8 }}>🔒</div>
      <div style={{ fontSize: fs(18), fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 6 }}>Área protegida</div>
      <div style={{ fontSize: fs(14), color: "var(--color-text-secondary)", marginBottom: 18 }}>
        Atendimentos, médicos e receitas ficam trancados.
      </div>

      {native && (
        <button onClick={tryBio} disabled={busy}
          style={{ width: "100%", minHeight: 54, borderRadius: 14, border: "none", background: ACCENT, color: "#fff", fontSize: fs(16), fontWeight: 700, cursor: "pointer", marginBottom: 10, opacity: busy ? 0.6 : 1 }}>
          ☝️ Desbloquear com a digital
        </button>
      )}

      {showPw ? (
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 }}>Senha da conta</div>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") tryPw(); }}
            placeholder="Digite a senha"
            style={{ width: "100%", padding: "12px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", fontSize: fs(15), background: "transparent", color: "var(--color-text-primary)", marginBottom: 10 }} />
          <button onClick={tryPw} disabled={busy || !pw}
            style={{ width: "100%", minHeight: 50, borderRadius: 14, border: "none", background: GREEN, color: "#fff", fontSize: fs(15), fontWeight: 700, cursor: "pointer", opacity: busy || !pw ? 0.6 : 1 }}>
            Desbloquear com a senha
          </button>
        </div>
      ) : (
        <button onClick={() => setShowPw(true)}
          style={{ background: "transparent", border: "none", textDecoration: "underline", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: fs(13), padding: 10 }}>
          Usar a senha da conta
        </button>
      )}

      {msg && <div style={{ fontSize: fs(13), color: RED, marginTop: 12 }}>{msg}</div>}
    </div>
  );
}

// ── Miniatura de um arquivo ───────────────────────────
function FileThumb({ file, onOpen, onRemove, onEdit, fs }: { file: HealthFile; onOpen: () => void; onRemove: () => void; onEdit: () => void; fs: (n: number) => number }) {
  const isImage = file.type.startsWith("image/");
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    let url: string | null = null;
    getHealthFileBlob(file)
      .then((b) => {
        if (!alive) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.path]);

  const mini: React.CSSProperties = {
    position: "absolute", top: 5, width: 30, height: 30, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.7)",
    color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, zIndex: 2,
  };

  return (
    <div style={{ position: "relative", width: 96, height: 96, flexShrink: 0 }}>
      <button onClick={onOpen} aria-label={`Abrir ${file.name}`}
        style={{ width: 96, height: 96, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "var(--color-background-secondary)", cursor: "pointer", padding: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 2 }}>
        {isImage && src ? (
          <img src={src} alt={file.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <>
            <span style={{ fontSize: 28 }}>{isImage ? (failed ? "🚫" : "⏳") : "📄"}</span>
            <span style={{ fontSize: fs(10), color: "var(--color-text-secondary)", padding: "0 4px", wordBreak: "break-all", maxHeight: 24, overflow: "hidden" }}>
              {failed ? "indisponível" : file.name}
            </span>
          </>
        )}
      </button>
      <button onClick={onEdit} aria-label="Editar arquivo" style={{ ...mini, left: 5 }}><Pencil size={14} /></button>
      <button onClick={onRemove} aria-label="Remover arquivo" style={{ ...mini, right: 5 }}><X size={15} /></button>
      {file.pending && (
        <span title="Ainda não enviado para a nuvem" style={{ position: "absolute", left: 5, bottom: 5, fontSize: 12, background: "rgba(255,255,255,0.9)", borderRadius: 6, padding: "0 3px" }}>⏳</span>
      )}
    </div>
  );
}

// ── Visualizador (foto com zoom / PDF) ────────────────
function FileViewer({ file, onClose, fs }: { file: HealthFile; onClose: () => void; fs: (n: number) => number }) {
  const isImage = file.type.startsWith("image/");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    getHealthFileBlob(file)
      .then((b) => {
        if (!alive) return;
        setBlob(b);
        if (isImage) {
          url = URL.createObjectURL(b);
          setSrc(url);
        }
      })
      .catch(() => alive && setError("Sem internet e sem cópia deste arquivo no aparelho."));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.path]);

  const send = async () => {
    if (!blob) return;
    const r = await shareFiles([{ blob, name: file.name }], file.name);
    if (r === "failed") toast({ title: "Não consegui enviar", variant: "destructive" });
  };

  const openPdf = async () => {
    if (!blob) return;
    const r = await abrirArquivo(blob, file.name);
    if (r === "sem-leitor") toast({ title: "Sem leitor de PDF", description: "Instale um aplicativo que abre PDF (por exemplo, o Google Drive) ou use o botão Enviar.", variant: "destructive" });
    if (r === "falhou") {
      toast({ title: "Não consegui abrir aqui", description: "Escolha o aplicativo na lista que vai aparecer." });
      await send();
    }
  };

  const btn: React.CSSProperties = { minWidth: 48, height: 48, borderRadius: 12, border: "none", background: "rgba(255,255,255,0.16)", color: "#fff", cursor: "pointer", fontSize: fs(15), fontWeight: 700, padding: "0 12px" };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.92)", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", paddingTop: "max(10px, env(safe-area-inset-top, 0px))" }}>
        <div style={{ flex: 1, minWidth: 0, color: "#fff", fontSize: fs(13), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
        {isImage && <button style={btn} onClick={() => setZoom((z) => Math.max(1, z - 0.5))} aria-label="Diminuir zoom">−</button>}
        {isImage && <button style={btn} onClick={() => setZoom((z) => Math.min(4, z + 0.5))} aria-label="Aumentar zoom">+</button>}
        <button style={btn} onClick={send} disabled={!blob}>Enviar</button>
        <button style={{ ...btn, background: RED }} onClick={onClose} aria-label="Fechar"><X size={18} /></button>
      </div>
      <div style={{ flex: 1, overflow: "auto", WebkitOverflowScrolling: "touch", textAlign: "center", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
        {error && <div style={{ color: "#fff", padding: 30, fontSize: fs(15) }}>{error}</div>}
        {!error && isImage && (src
          ? <img src={src} alt={file.name} style={{ width: `${zoom * 100}%`, maxWidth: "none", height: "auto" }} />
          : <div style={{ color: "#fff", padding: 30 }}>Carregando…</div>)}
        {!error && !isImage && (
          <div style={{ color: "#fff", padding: 30 }}>
            <div style={{ fontSize: 56, marginBottom: 10 }}>📄</div>
            <div style={{ fontSize: fs(15), marginBottom: 16, wordBreak: "break-word" }}>{file.name}</div>
            <div style={{ display: "flex", gap: 10, maxWidth: 420, margin: "0 auto" }}>
              <button style={{ ...btn, background: GREEN, minHeight: 54, flex: 1, padding: "0 12px" }} onClick={openPdf} disabled={!blob}>📄 Abrir PDF</button>
              <button style={{ ...btn, minHeight: 54, flex: 1, padding: "0 12px", border: "1px solid rgba(255,255,255,0.5)", background: "transparent" }} onClick={send} disabled={!blob}>📤 Enviar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Editor de um atendimento ──────────────────────────
function VisitEditor({
  initial, isNew, userId, suggestions, dir, onDirChange, scale, onSave, onDelete, onClose, onCreateMedication,
}: {
  initial: HealthVisit;
  isNew: boolean;
  userId: string;
  suggestions: { doctors: string[]; places: string[]; meds: RxItem[] };
  dir: HealthDirectory;
  onDirChange: (d: HealthDirectory) => void;
  scale: number;
  onSave: (v: HealthVisit, removed: HealthFile[]) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
  onCreateMedication?: (p: MedPrefill) => void;
}) {
  const fs = (px: number) => Math.round(px * scale * 10) / 10;
  const linkedIds = useMemo(() => loadLinkedItemIds(userId), [userId]);
  const [draft, setDraft] = useState<HealthVisit>(() => JSON.parse(JSON.stringify(initial)));
  const initialJson = useRef(JSON.stringify(initial));
  const originalFiles = useRef<HealthFile[]>(allFiles(initial));
  const sessionFiles = useRef<HealthFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<HealthFile | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; yes: () => void } | null>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const targetFiles = useRef<FileTarget>({ kind: "rx", id: "" });
  const replaceRef = useRef<string | null>(null);
  const [fileMenu, setFileMenu] = useState<{ target: FileTarget; file: HealthFile } | null>(null);
  const [renomear, setRenomear] = useState<{ target: FileTarget; file: HealthFile; texto: string } | null>(null);
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [openExtra, setOpenExtra] = useState<string | null>(null);

  const dirty = JSON.stringify(draft) !== initialJson.current;

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "11px 12px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)",
    fontSize: fs(15), background: "transparent", color: "var(--color-text-primary)",
  };
  const labelStyle: React.CSSProperties = { fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 };
  const set = <K extends keyof HealthVisit>(key: K, value: HealthVisit[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const updRx = (idx: number, patch: Partial<Prescription>) =>
    setDraft((d) => ({ ...d, prescriptions: d.prescriptions.map((p, i) => (i === idx ? { ...p, ...patch } : p)) }));

  const addRx = () => setDraft((d) => ({ ...d, prescriptions: [...d.prescriptions, newPrescription(d.prescriptions.length + 1)] }));

  const addItem = (idx: number) => {
    const id = crypto.randomUUID();
    updRx(idx, { items: [...draft.prescriptions[idx].items, { id, name: "", qty: "", bought: false, amount: 1 }] });
    setOpenItem(id);
  };

  // Ao digitar um nome que você já usou antes, puxa a dose e a embalagem da última vez
  const onItemName = (idx: number, it: RxItem, value: string) => {
    const known = suggestions.meds.find((m) => m.name.trim().toLowerCase() === value.trim().toLowerCase());
    const patch: Partial<RxItem> = { name: value };
    if (known && !it.strength && !it.unit && !it.form) {
      patch.strength = known.strength;
      patch.unit = known.unit;
      patch.form = known.form;
      patch.amount = known.amount && known.amount > 0 ? known.amount : 1;
    }
    updItem(idx, it.id, patch);
  };

  const closeItem = (idx: number, it: RxItem) => {
    if (!it.name.trim()) {
      if (!it.strength && !it.unit && !it.form && !it.qty.trim()) {
        delItem(idx, it.id);
        setOpenItem(null);
      } else {
        toast({ title: "Digite o nome do remédio", variant: "destructive" });
      }
      return;
    }
    setOpenItem(null);
  };

  const updItem = (idx: number, itemId: string, patch: Partial<RxItem>) =>
    updRx(idx, { items: draft.prescriptions[idx].items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) });

  const delItem = (idx: number, itemId: string) =>
    updRx(idx, { items: draft.prescriptions[idx].items.filter((it) => it.id !== itemId) });

  // ── anexar ──
  const listOf = (t: FileTarget): HealthFile[] => {
    if (t.kind === "rx") return draft.prescriptions.find((p) => p.id === t.id)?.files ?? [];
    if (t.kind === "examReq") return draft.exams.find((e) => e.id === t.id)?.files ?? [];
    if (t.kind === "examRes") return draft.exams.find((e) => e.id === t.id)?.resultFiles ?? [];
    if (t.kind === "referral") return draft.referrals.find((r) => r.id === t.id)?.files ?? [];
    return draft.procedures.find((p) => p.id === t.id)?.files ?? [];
  };

  const mapList = (t: FileTarget, fn: (files: HealthFile[]) => HealthFile[]) =>
    setDraft((d) => ({
      ...d,
      prescriptions: t.kind === "rx" ? d.prescriptions.map((p) => (p.id === t.id ? { ...p, files: fn(p.files) } : p)) : d.prescriptions,
      exams:
        t.kind === "examReq" ? d.exams.map((e) => (e.id === t.id ? { ...e, files: fn(e.files) } : e))
        : t.kind === "examRes" ? d.exams.map((e) => (e.id === t.id ? { ...e, resultFiles: fn(e.resultFiles) } : e))
        : d.exams,
      referrals: t.kind === "referral" ? d.referrals.map((r) => (r.id === t.id ? { ...r, files: fn(r.files) } : r)) : d.referrals,
      procedures: t.kind === "procedure" ? d.procedures.map((p) => (p.id === t.id ? { ...p, files: fn(p.files) } : p)) : d.procedures,
    }));

  const processFile = async (target: FileTarget, file: File, replaceId?: string) => {
    if (listOf(target).length >= MAX_FILES_PER_PRESCRIPTION) {
      toast({ title: "Limite de arquivos", description: `No máximo ${MAX_FILES_PER_PRESCRIPTION} arquivos em cada grupo.`, variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const t = (file.type || "").toLowerCase();
      const isPdf = t === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      let blob: Blob;
      let type: string;
      let name = file.name || "arquivo";
      if (isPdf) {
        if (file.size > MAX_FILE_BYTES) {
          toast({ title: "PDF grande demais", description: "O limite é 5 MB por arquivo.", variant: "destructive" });
          return;
        }
        blob = file;
        type = "application/pdf";
      } else if (t.startsWith("image/") || /\.(jpe?g|png|webp|heic)$/i.test(name)) {
        blob = await compressImage(file);
        type = "image/jpeg";
        name = name.replace(/\.\w+$/, "") + ".jpg";
      } else {
        toast({ title: "Tipo de arquivo não aceito", description: "Use foto ou PDF.", variant: "destructive" });
        return;
      }
      const stored = await storeHealthFile(userId, blob, name, type);
      sessionFiles.current.push(stored);
      mapList(target, (files) => (replaceId ? files.map((f) => (f.id === replaceId ? stored : f)) : [...files, stored]));
      toast({
        title: stored.pending ? "Guardado no aparelho" : "Anexado",
        description: stored.pending ? "Vai para a nuvem quando houver internet. Toque em Salvar atendimento." : "Toque em Salvar atendimento para guardar.",
      });
    } catch {
      toast({ title: "Não consegui anexar o arquivo", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const onPickCamera = async (target: FileTarget, replaceId?: string) => {
    if (Capacitor.isNativePlatform()) {
      const f = await takeNativePhoto("camera");
      if (f) await processFile(target, f, replaceId);
    } else {
      targetFiles.current = target;
      replaceRef.current = replaceId ?? null;
      cameraInput.current?.click();
    }
  };

  const onPickFile = (target: FileTarget, replaceId?: string) => {
    targetFiles.current = target;
    replaceRef.current = replaceId ?? null;
    fileInput.current?.click();
  };

  const onInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    let trocar = replaceRef.current ?? undefined;
    replaceRef.current = null;
    for (const f of files) {
      await processFile(targetFiles.current, f, trocar);
      trocar = undefined; // só o primeiro substitui; os outros entram como novos
    }
  };

  const girar = async (target: FileTarget, file: HealthFile) => {
    setBusy(true);
    try {
      const girada = await rotateImage90(await getHealthFileBlob(file));
      const nova = await storeHealthFile(userId, girada, file.name, "image/jpeg");
      sessionFiles.current.push(nova);
      mapList(target, (files) => files.map((f) => (f.id === file.id ? nova : f)));
    } catch {
      toast({ title: "Não consegui girar a foto", description: "Sem internet e sem cópia no aparelho.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const salvarNome = () => {
    if (!renomear) return;
    const r = renomear;
    let nome = r.texto.trim();
    if (!nome) return;
    const ext = r.file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "";
    if (ext && !/\.[A-Za-z0-9]+$/.test(nome)) nome += ext;
    mapList(r.target, (files) => files.map((f) => (f.id === r.file.id ? { ...f, name: nome } : f)));
    setRenomear(null);
  };

  const removeFile = (target: FileTarget, fileId: string) =>
    setConfirm({
      text: "Remover este arquivo?",
      yes: () => {
        setConfirm(null);
        mapList(target, (files) => files.filter((f) => f.id !== fileId));
      },
    });

  // ── enviar ──
  const sendRx = async (rx: Prescription, asPdf: boolean) => {
    if (!rx.files.length) return;
    setBusy(true);
    try {
      let items: { blob: Blob; name: string }[];
      if (asPdf) {
        const imgs = rx.files.filter((f) => f.type.startsWith("image/"));
        if (!imgs.length) {
          toast({ title: "Sem fotos para o PDF", description: "Só as fotos entram no PDF.", variant: "destructive" });
          return;
        }
        const blobs: Blob[] = [];
        for (const f of imgs) blobs.push(await getHealthFileBlob(f));
        items = [{ blob: await imagesToPdf(blobs), name: `receita-${draft.visit_date}.pdf` }];
      } else {
        items = [];
        for (const f of rx.files) items.push({ blob: await getHealthFileBlob(f), name: f.name });
      }
      const r = await shareFiles(items, rx.title || "Receita");
      if (r === "failed") toast({ title: "Não consegui enviar", variant: "destructive" });
      if (r === "saved") toast({ title: "Arquivo salvo no aparelho" });
    } catch {
      toast({ title: "Não consegui preparar os arquivos", description: "Sem internet e sem cópia no aparelho.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const sendList = async (files: HealthFile[], title: string) => {
    if (!files.length) return;
    setBusy(true);
    try {
      const items: { blob: Blob; name: string }[] = [];
      for (const f of files) items.push({ blob: await getHealthFileBlob(f), name: f.name });
      const r = await shareFiles(items, title);
      if (r === "failed") toast({ title: "Não consegui enviar", variant: "destructive" });
      if (r === "saved") toast({ title: "Arquivo salvo no aparelho" });
    } catch {
      toast({ title: "Não consegui preparar os arquivos", description: "Sem internet e sem cópia no aparelho.", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  // ── salvar / sair ──
  const save = async (after?: () => void) => {
    setBusy(true);
    try {
      const finalIds = new Set(allFiles(draft).map((f) => f.id));
      const known = [...originalFiles.current, ...sessionFiles.current];
      const removed = known.filter((f) => !finalIds.has(f.id));
      await onSave(draft, removed);
      after?.();
    } finally {
      setBusy(false);
    }
  };

  // Salva o atendimento e abre o cadastro do remédio (aba Remédios) já preenchido
  const registerMed = async (it: RxItem) => {
    const prefill = buildMedPrefill(it, draft);
    await save(() => onCreateMedication?.(prefill));
  };

  const close = () => {
    if (!dirty) { onClose(); return; }
    setConfirm({
      text: "Descartar as alterações deste atendimento?",
      yes: async () => {
        setConfirm(null);
        await deleteHealthFiles(sessionFiles.current);
        onClose();
      },
    });
  };

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "9px 12px", minHeight: 40, borderRadius: 20, cursor: "pointer", fontSize: fs(13),
    border: `1.5px solid ${active ? ACCENT : "var(--color-border-secondary)"}`,
    background: active ? ACCENT : "transparent", color: active ? "#fff" : "var(--color-text-primary)", fontWeight: active ? 600 : 400,
  });

  const smallBtn: React.CSSProperties = {
    flex: 1, minHeight: 46, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent",
    cursor: "pointer", fontSize: fs(13), fontWeight: 600, color: "var(--color-text-primary)",
  };

  // ── exames, encaminhamentos e procedimentos ──
  const sectionTitle: React.CSSProperties = { fontSize: fs(15), fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 8 };
  const addBtn: React.CSSProperties = {
    width: "100%", minHeight: 52, borderRadius: 14, border: "1.5px dashed var(--color-border-secondary)", background: "transparent",
    cursor: "pointer", fontSize: fs(14), fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 18,
    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  };
  const expandedBox: React.CSSProperties = { border: `1.5px solid ${ACCENT}`, borderRadius: 14, padding: 12, marginBottom: 10, background: "var(--color-background-primary)" };
  const badge = (bg: string, fg: string): React.CSSProperties => ({ fontSize: fs(12), fontWeight: 600, padding: "6px 10px", borderRadius: 20, background: bg, color: fg });

  const patchExam = (id: string, patch: Partial<Exam>) => setDraft((d) => ({ ...d, exams: d.exams.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const patchReferral = (id: string, patch: Partial<Referral>) => setDraft((d) => ({ ...d, referrals: d.referrals.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const patchProcedure = (id: string, patch: Partial<Procedure>) => setDraft((d) => ({ ...d, procedures: d.procedures.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));

  const askConfirm = (text: string, yes: () => void) => setConfirm({ text, yes: () => { setConfirm(null); yes(); } });

  const askDelete = (label: string, yes: () => void) =>
    setConfirm({ text: `Excluir "${label}" e os arquivos dele?`, yes: () => { setConfirm(null); yes(); } });

  // "Pronto": sem nome e sem mais nada preenchido, descarta; com dados mas sem nome, avisa
  const closeExtra = (named: boolean, hasOther: boolean, remove: () => void) => {
    if (named) { setOpenExtra(null); return; }
    if (!hasOther) { remove(); setOpenExtra(null); return; }
    toast({ title: "Preencha o nome", variant: "destructive" });
  };

  const dateField = (value: string, onChange: (v: string) => void) => (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      {value && <button onClick={() => onChange("")} style={{ ...smallBtn, flex: "0 0 auto", padding: "0 12px" }}>Sem data</button>}
    </div>
  );

  const statusChips = (options: readonly string[], value: string, onChange: (v: string) => void) => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
      {options.map((o) => <button key={o} onClick={() => onChange(o)} style={chip(value === o)}>{o}</button>)}
    </div>
  );

  const filesBlock = (target: FileTarget, files: HealthFile[], label: string) => (
    <div style={{ marginBottom: 12 }}>
      <div style={labelStyle}>{label}</div>
      {files.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          {files.map((f) => <FileThumb key={f.id} file={f} fs={fs} onOpen={() => setViewer(f)} onRemove={() => removeFile(target, f.id)} onEdit={() => setFileMenu({ target, file: f })} />)}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button style={smallBtn} onClick={() => onPickCamera(target)} disabled={busy}>📷 Tirar foto</button>
        <button style={smallBtn} onClick={() => onPickFile(target)} disabled={busy}>📎 Foto ou PDF</button>
      </div>
      {files.length > 0 && (
        <button style={{ ...smallBtn, width: "100%", marginTop: 8, background: GREEN, color: "#fff", border: "none" }} onClick={() => sendList(files, label)} disabled={busy}>📤 Enviar</button>
      )}
    </div>
  );

  const doneBtn = (onClick: () => void) => (
    <button onClick={onClick} style={{ width: "100%", minHeight: 48, borderRadius: 12, border: "none", background: ACCENT, color: "#fff", fontSize: fs(14), fontWeight: 700, cursor: "pointer" }}>Pronto</button>
  );

  const extraRow = (id: string, title: string, sub: string, onEdit: () => void, onDelete: () => void, extra?: React.ReactNode) => (
    <div key={id} style={{ marginBottom: 8, background: "var(--color-background-secondary)", borderRadius: 12, padding: 8, border: "0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0, padding: "0 6px" }}>
          <div style={{ fontSize: fs(14), fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{title}</div>
          {sub && <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", wordBreak: "break-word" }}>{sub}</div>}
        </div>
        <button onClick={onEdit} aria-label={`Editar ${title}`}
          style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 18 }}>✏️</button>
        <button onClick={onDelete} aria-label={`Excluir ${title}`}
          style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Trash2 size={18} color={RED} />
        </button>
      </div>
      {extra}
    </div>
  );

  return (
    <div style={{ opacity: busy ? 0.7 : 1 }}>
      <datalist id="hv-meds">{suggestions.meds.map((m) => <option key={m.id} value={m.name} />)}</datalist>
      <datalist id="hv-places">{suggestions.places.map((d) => <option key={d} value={d} />)}</datalist>
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onInputChange} />
      <input ref={fileInput} type="file" accept="image/*,application/pdf" multiple style={{ display: "none" }} onChange={onInputChange} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <button onClick={close}
          style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: fs(14), fontWeight: 500, padding: "10px 0", minHeight: 44 }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          Voltar
        </button>
        <div style={{ fontSize: fs(16), fontWeight: 600, color: "var(--color-text-primary)" }}>{isNew ? "Novo atendimento" : "Atendimento"}</div>
        <div style={{ width: 60 }} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Data do atendimento</div>
        <input type="date" value={draft.visit_date} onChange={(e) => e.target.value && set("visit_date", e.target.value)} style={inputStyle} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Onde foi atendido</div>
        <LocalField type={draft.place_type} name={draft.place_name} dir={dir} fs={fs} askConfirm={askConfirm}
          onPick={(t, n) => setDraft((d) => ({ ...d, place_type: t, place_name: n }))} onDirChange={onDirChange} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Médico(a) e CRM</div>
        <MedicoField name={draft.doctor_name} crm={draft.doctor_crm} dir={dir} fs={fs} askConfirm={askConfirm}
          onPick={(n, c) => setDraft((d) => ({ ...d, doctor_name: n, doctor_crm: c }))}
          onCrmChange={(c) => set("doctor_crm", c)} onDirChange={onDirChange} />
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Motivo do atendimento</div>
        <input value={draft.reason} onChange={(e) => set("reason", e.target.value)} placeholder="Por que procurou atendimento?" style={{ ...inputStyle, marginBottom: 8 }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {MOTIVOS.map((m) => (
            <button key={m} type="button" onClick={() => set("reason", !draft.reason.trim() ? m : draft.reason.includes(m) ? draft.reason : `${draft.reason.trim()}, ${m}`)} style={chip(draft.reason.includes(m))}>{m}</button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={labelStyle}>Anotações (o que sentia, orientações do médico)</div>
        <textarea value={draft.notes} onChange={(e) => set("notes", e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
      </div>

      {/* Receitas */}
      <div style={{ fontSize: fs(15), fontWeight: 700, color: "var(--color-text-primary)", marginBottom: 8 }}>Receitas ({draft.prescriptions.length})</div>

      {draft.prescriptions.map((rx, idx) => (
        <div key={rx.id} style={{ background: "var(--color-background-secondary)", borderRadius: 16, padding: 12, marginBottom: 12, border: "0.5px solid var(--color-border-tertiary)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <input value={rx.title} onChange={(e) => updRx(idx, { title: e.target.value })} style={{ ...inputStyle, fontWeight: 600 }} aria-label="Nome da receita" />
            <button aria-label="Excluir receita"
              onClick={() => setConfirm({ text: `Excluir "${rx.title}" e os arquivos dela?`, yes: () => { setConfirm(null); setDraft((d) => ({ ...d, prescriptions: d.prescriptions.filter((_, i) => i !== idx) })); } })}
              style={{ width: 46, height: 46, flexShrink: 0, borderRadius: 12, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Trash2 size={18} color={RED} />
            </button>
          </div>

          {/* Arquivos */}
          <div style={labelStyle}>Foto ou PDF da receita</div>
          {rx.files.length > 0 && (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              {rx.files.map((f) => (
                <FileThumb key={f.id} file={f} fs={fs} onOpen={() => setViewer(f)} onRemove={() => removeFile({ kind: "rx", id: rx.id }, f.id)} onEdit={() => setFileMenu({ target: { kind: "rx", id: rx.id }, file: f })} />
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button style={smallBtn} onClick={() => onPickCamera({ kind: "rx", id: rx.id })} disabled={busy}>📷 Tirar foto</button>
            <button style={smallBtn} onClick={() => onPickFile({ kind: "rx", id: rx.id })} disabled={busy}>📎 Foto ou PDF</button>
          </div>
          {rx.files.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button style={{ ...smallBtn, background: GREEN, color: "#fff", border: "none" }} onClick={() => sendRx(rx, false)} disabled={busy}>📤 Enviar</button>
              {rx.files.some((f) => f.type.startsWith("image/")) && (
                <button style={{ ...smallBtn, background: ACCENT, color: "#fff", border: "none" }} onClick={() => sendRx(rx, true)} disabled={busy}>📑 Enviar em PDF</button>
              )}
            </div>
          )}

          {/* Remédios da receita */}
          <div style={labelStyle}>Remédios da receita</div>
          {rx.items.map((it) => {
            const { title, sub } = itemSummary(it);
            if (openItem !== it.id) {
              return (
                <div key={it.id} style={{ marginBottom: 8, background: "var(--color-background-primary)", borderRadius: 12, padding: 6, border: "0.5px solid var(--color-border-tertiary)" }}>
                  <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button onClick={() => updItem(idx, it.id, { bought: !it.bought })} aria-label={it.bought ? "Marcar como não comprado" : "Marcar como comprado"}
                    style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: `1.5px solid ${it.bought ? GREEN : "var(--color-border-secondary)"}`, background: it.bought ? "#E1F5EE" : "transparent", cursor: "pointer", fontSize: 18 }}>
                    {it.bought ? "✅" : "🛒"}
                  </button>
                  <div style={{ flex: 1, minWidth: 0, padding: "0 4px" }}>
                    <div style={{ fontSize: fs(14), fontWeight: 600, color: "var(--color-text-primary)", textDecoration: it.bought ? "line-through" : "none", wordBreak: "break-word" }}>{title}</div>
                    {sub && <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", wordBreak: "break-word" }}>{sub}</div>}
                  </div>
                  <button onClick={() => setOpenItem(it.id)} aria-label={`Editar ${it.name || "remédio"}`}
                    style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 18 }}>✏️</button>
                  <button onClick={() => setConfirm({ text: `Remover "${it.name.trim() || "este remédio"}" da receita?`, yes: () => { setConfirm(null); delItem(idx, it.id); } })} aria-label="Remover remédio"
                    style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 12, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Trash2 size={18} color={RED} />
                  </button>
                  </div>
                  {onCreateMedication && it.name.trim() && (linkedIds.has(it.id) ? (
                    <div style={{ marginTop: 6, textAlign: "center", fontSize: fs(12), fontWeight: 600, color: "#085041", background: "#E1F5EE", borderRadius: 10, padding: "8px 6px" }}>⏰ Em uso nos Remédios</div>
                  ) : (
                    <button onClick={() => setConfirm({ text: `Salvar este atendimento e cadastrar "${rxTitle(it)}" com alarme?`, yes: () => { setConfirm(null); registerMed(it); } })}
                      style={{ width: "100%", marginTop: 6, minHeight: 44, borderRadius: 10, border: `1px dashed ${GREEN}`, background: "transparent", color: GREEN, fontSize: fs(13), fontWeight: 700, cursor: "pointer" }}>
                      ⏰ Cadastrar com alarme
                    </button>
                  ))}
                </div>
              );
            }
            const amount = it.amount && it.amount > 0 ? it.amount : 1;
            return (
              <div key={it.id} style={{ border: `1.5px solid ${ACCENT}`, borderRadius: 14, padding: 12, marginBottom: 10, background: "var(--color-background-primary)" }}>
                <div style={labelStyle}>Nome do remédio</div>
                <input list="hv-meds" value={it.name} onChange={(e) => onItemName(idx, it, e.target.value)} placeholder="Digite o nome (os já usados aparecem)" style={{ ...inputStyle, marginBottom: 12 }} autoFocus={!it.name} />

                <div style={labelStyle}>Dose (concentração)</div>
                <input inputMode="decimal" value={it.strength || ""} onChange={(e) => updItem(idx, it.id, { strength: e.target.value.replace(/[^0-9.,]/g, "") })} placeholder="Número (ex.: 500)" style={{ ...inputStyle, marginBottom: 8 }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {RX_UNITS.map((u) => (
                    <button key={u} onClick={() => updItem(idx, it.id, { unit: it.unit === u ? "" : u })} style={chip(it.unit === u)}>{u}</button>
                  ))}
                </div>

                <div style={labelStyle}>Embalagem</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {RX_FORMS.map((f) => (
                    <button key={f} onClick={() => updItem(idx, it.id, { form: it.form === f ? "" : f })} style={chip(it.form === f)}>{f}</button>
                  ))}
                </div>

                <div style={labelStyle}>Quantidade</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => updItem(idx, it.id, { amount: Math.max(1, amount - 1) })} aria-label="Diminuir"
                    style={{ width: 48, height: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(22), color: "var(--color-text-primary)" }}>−</button>
                  <span style={{ minWidth: 44, textAlign: "center", fontSize: fs(20), fontWeight: 700, color: "var(--color-text-primary)" }}>{amount}</span>
                  <button onClick={() => updItem(idx, it.id, { amount: amount + 1 })} aria-label="Aumentar"
                    style={{ width: 48, height: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(22), color: "var(--color-text-primary)" }}>+</button>
                  <span style={{ fontSize: fs(13), color: "var(--color-text-secondary)" }}>{it.form ? it.form.toLowerCase() + (amount > 1 ? "s" : "") : "embalagem"}</span>
                </div>

                <div style={labelStyle}>Quantidade total (ex.: 21 comprimidos)</div>
                <input inputMode="decimal" value={it.totalQty || ""} onChange={(e) => updItem(idx, it.id, { totalQty: e.target.value.replace(/[^0-9.,]/g, "") })} placeholder="Número" style={{ ...inputStyle, width: 120, marginBottom: 8 }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {RX_TOTAL_UNITS.map((u) => (
                    <button key={u} onClick={() => updItem(idx, it.id, { totalUnit: it.totalUnit === u ? "" : u })} style={chip(it.totalUnit === u)}>{u}</button>
                  ))}
                </div>

                <div style={labelStyle}>Como tomar</div>
                <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginBottom: 4 }}>Quanto por vez</div>
                <input inputMode="decimal" value={it.doseQty || ""} onChange={(e) => updItem(idx, it.id, { doseQty: e.target.value.replace(/[^0-9.,]/g, "") })} placeholder="Ex.: 3" style={{ ...inputStyle, width: 120, marginBottom: 8 }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {RX_DOSE_UNITS.map((u) => (
                    <button key={u} onClick={() => updItem(idx, it.id, { doseUnit: it.doseUnit === u ? "" : u })} style={chip(it.doseUnit === u)}>{u}</button>
                  ))}
                </div>
                <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginBottom: 4 }}>Via</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                  {RX_VIAS.map((v) => (
                    <button key={v} onClick={() => updItem(idx, it.id, { via: it.via === v ? "" : v })} style={chip(it.via === v)}>{v}</button>
                  ))}
                </div>
                <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginBottom: 4 }}>Vezes ao dia</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <button onClick={() => updItem(idx, it.id, { vezesDia: Math.max(0, (it.vezesDia || 0) - 1) })} aria-label="Diminuir"
                    style={{ width: 48, height: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(22), color: "var(--color-text-primary)" }}>−</button>
                  <span style={{ minWidth: 44, textAlign: "center", fontSize: fs(20), fontWeight: 700, color: "var(--color-text-primary)" }}>{it.vezesDia && it.vezesDia > 0 ? it.vezesDia : "—"}</span>
                  <button onClick={() => updItem(idx, it.id, { vezesDia: Math.min(12, (it.vezesDia || 0) + 1) })} aria-label="Aumentar"
                    style={{ width: 48, height: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(22), color: "var(--color-text-primary)" }}>+</button>
                  <span style={{ fontSize: fs(13), color: "var(--color-text-secondary)" }}>{it.vezesDia === 1 ? "vez ao dia" : "vezes ao dia"}</span>
                </div>

                <div style={labelStyle}>Observação (opcional)</div>
                <input value={it.qty} onChange={(e) => updItem(idx, it.id, { qty: e.target.value })} placeholder="Ex.: 21 comprimidos; 1 a cada 8 horas" style={{ ...inputStyle, marginBottom: 12 }} />

                <button onClick={() => closeItem(idx, it)}
                  style={{ width: "100%", minHeight: 48, borderRadius: 12, border: "none", background: ACCENT, color: "#fff", fontSize: fs(14), fontWeight: 700, cursor: "pointer" }}>
                  Pronto
                </button>
              </div>
            );
          })}
          <button onClick={() => addItem(idx)}
            style={{ width: "100%", minHeight: 44, borderRadius: 12, border: "1px dashed var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(13), color: "var(--color-text-secondary)" }}>
            + Adicionar remédio da receita
          </button>
        </div>
      ))}

      <button onClick={addRx}
        style={{ width: "100%", minHeight: 52, borderRadius: 14, border: "1.5px dashed var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(14), fontWeight: 600, color: "var(--color-text-secondary)", marginBottom: 18, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <Plus size={18} /> Adicionar receita
      </button>

      {/* Exames */}
      <div style={sectionTitle}>🔬 Exames ({draft.exams.length})</div>
      {draft.exams.map((e) => openExtra !== e.id ? (
        extraRow(
          e.id,
          e.name.trim() || "Exame sem nome",
          [e.status, e.date ? fmtDate(e.date) : "", e.place].filter(Boolean).join(" · "),
          () => setOpenExtra(e.id),
          () => askDelete(e.name.trim() || "este exame", () => setDraft((d) => ({ ...d, exams: d.exams.filter((x) => x.id !== e.id) }))),
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
            <span style={badge("#EEF1F6", "#445066")}>📎 pedido: {e.files.length}</span>
            <span style={e.resultFiles.length ? badge("#E1F5EE", "#085041") : badge("#FAEEDA", "#633806")}>
              {e.resultFiles.length ? `✅ resultado: ${e.resultFiles.length}` : "⏳ sem resultado"}
            </span>
            <button onClick={() => onPickFile({ kind: "examRes", id: e.id })} disabled={busy} style={{ ...smallBtn, flex: "1 1 auto", minHeight: 40 }}>📎 Anexar resultado</button>
          </div>
        )
      ) : (
        <div key={e.id} style={expandedBox}>
          <div style={labelStyle}>Nome do exame</div>
          <input value={e.name} onChange={(ev) => patchExam(e.id, { name: ev.target.value })} placeholder="Ex.: Raio-X do joelho" style={{ ...inputStyle, marginBottom: 12 }} autoFocus={!e.name} />
          <div style={labelStyle}>Onde fazer (laboratório ou clínica)</div>
          <input list="hv-places" value={e.place} onChange={(ev) => patchExam(e.id, { place: ev.target.value })} style={{ ...inputStyle, marginBottom: 12 }} />
          <div style={labelStyle}>Situação</div>
          {statusChips(EXAM_STATUS, e.status, (v) => patchExam(e.id, { status: v }))}
          <div style={labelStyle}>Data (agendada ou feita)</div>
          {dateField(e.date, (v) => patchExam(e.id, { date: v }))}
          <div style={labelStyle}>Observações (opcional)</div>
          <input value={e.notes} onChange={(ev) => patchExam(e.id, { notes: ev.target.value })} placeholder="Ex.: ir em jejum de 8 horas" style={{ ...inputStyle, marginBottom: 12 }} />
          {filesBlock({ kind: "examReq", id: e.id }, e.files, "Pedido do exame (foto ou PDF)")}
          {filesBlock({ kind: "examRes", id: e.id }, e.resultFiles, "Resultado do exame (foto ou PDF)")}
          {doneBtn(() => closeExtra(!!e.name.trim(), !!(e.place.trim() || e.notes.trim() || e.date || e.files.length || e.resultFiles.length), () => setDraft((d) => ({ ...d, exams: d.exams.filter((x) => x.id !== e.id) }))))}
        </div>
      ))}
      <button onClick={() => { const e = newExam(); setDraft((d) => ({ ...d, exams: [...d.exams, e] })); setOpenExtra(e.id); }} style={addBtn}>
        <Plus size={18} /> Adicionar exame
      </button>

      {/* Encaminhamentos */}
      <div style={sectionTitle}>➡️ Encaminhamentos ({draft.referrals.length})</div>
      {draft.referrals.map((r) => openExtra !== r.id ? (
        extraRow(
          r.id,
          `Para: ${r.to.trim() || "(não informado)"}`,
          [r.status, r.date ? fmtDate(r.date) : "", r.place].filter(Boolean).join(" · "),
          () => setOpenExtra(r.id),
          () => askDelete(r.to.trim() || "este encaminhamento", () => setDraft((d) => ({ ...d, referrals: d.referrals.filter((x) => x.id !== r.id) }))),
          r.files.length > 0 ? <div style={{ marginTop: 8 }}><span style={badge("#EEF1F6", "#445066")}>📎 anexos: {r.files.length}</span></div> : undefined
        )
      ) : (
        <div key={r.id} style={expandedBox}>
          <div style={labelStyle}>Encaminhado para (especialidade ou médico)</div>
          <input value={r.to} onChange={(ev) => patchReferral(r.id, { to: ev.target.value })} placeholder="Ex.: Ortopedista" style={{ ...inputStyle, marginBottom: 12 }} autoFocus={!r.to} />
          <div style={labelStyle}>Onde (clínica ou hospital)</div>
          <input list="hv-places" value={r.place} onChange={(ev) => patchReferral(r.id, { place: ev.target.value })} style={{ ...inputStyle, marginBottom: 12 }} />
          <div style={labelStyle}>Situação</div>
          {statusChips(REFERRAL_STATUS, r.status, (v) => patchReferral(r.id, { status: v }))}
          <div style={labelStyle}>Data da consulta (se já marcada)</div>
          {dateField(r.date, (v) => patchReferral(r.id, { date: v }))}
          <div style={labelStyle}>Observações (opcional)</div>
          <input value={r.notes} onChange={(ev) => patchReferral(r.id, { notes: ev.target.value })} style={{ ...inputStyle, marginBottom: 12 }} />
          {filesBlock({ kind: "referral", id: r.id }, r.files, "Guia ou foto do encaminhamento")}
          {doneBtn(() => closeExtra(!!r.to.trim(), !!(r.place.trim() || r.notes.trim() || r.date || r.files.length), () => setDraft((d) => ({ ...d, referrals: d.referrals.filter((x) => x.id !== r.id) }))))}
        </div>
      ))}
      <button onClick={() => { const r = newReferral(); setDraft((d) => ({ ...d, referrals: [...d.referrals, r] })); setOpenExtra(r.id); }} style={addBtn}>
        <Plus size={18} /> Adicionar encaminhamento
      </button>

      {/* Outros procedimentos */}
      <div style={sectionTitle}>🩹 Outros procedimentos ({draft.procedures.length})</div>
      {draft.procedures.map((p) => openExtra !== p.id ? (
        extraRow(
          p.id,
          p.name.trim() || "Procedimento sem nome",
          [p.date ? fmtDate(p.date) : "", p.place].filter(Boolean).join(" · "),
          () => setOpenExtra(p.id),
          () => askDelete(p.name.trim() || "este procedimento", () => setDraft((d) => ({ ...d, procedures: d.procedures.filter((x) => x.id !== p.id) }))),
          p.files.length > 0 ? <div style={{ marginTop: 8 }}><span style={badge("#EEF1F6", "#445066")}>📎 anexos: {p.files.length}</span></div> : undefined
        )
      ) : (
        <div key={p.id} style={expandedBox}>
          <div style={labelStyle}>Procedimento</div>
          <input value={p.name} onChange={(ev) => patchProcedure(p.id, { name: ev.target.value })} placeholder="Ex.: Curativo, retirada de pontos" style={{ ...inputStyle, marginBottom: 12 }} autoFocus={!p.name} />
          <div style={labelStyle}>Onde foi feito</div>
          <input list="hv-places" value={p.place} onChange={(ev) => patchProcedure(p.id, { place: ev.target.value })} style={{ ...inputStyle, marginBottom: 12 }} />
          <div style={labelStyle}>Data</div>
          {dateField(p.date, (v) => patchProcedure(p.id, { date: v }))}
          <div style={labelStyle}>Observações (opcional)</div>
          <input value={p.notes} onChange={(ev) => patchProcedure(p.id, { notes: ev.target.value })} style={{ ...inputStyle, marginBottom: 12 }} />
          {filesBlock({ kind: "procedure", id: p.id }, p.files, "Fotos ou documentos")}
          {doneBtn(() => closeExtra(!!p.name.trim(), !!(p.place.trim() || p.notes.trim() || p.date || p.files.length), () => setDraft((d) => ({ ...d, procedures: d.procedures.filter((x) => x.id !== p.id) }))))}
        </div>
      ))}
      <button onClick={() => { const p = newProcedure(); setDraft((d) => ({ ...d, procedures: [...d.procedures, p] })); setOpenExtra(p.id); }} style={addBtn}>
        <Plus size={18} /> Adicionar procedimento
      </button>

      <button onClick={() => save()} disabled={busy}
        style={{ width: "100%", minHeight: 54, borderRadius: 14, border: "none", background: ACCENT, color: "#fff", fontSize: fs(15), fontWeight: 700, cursor: "pointer", marginBottom: 12, opacity: busy ? 0.6 : 1 }}>
        {busy ? "Aguarde…" : "Salvar atendimento"}
      </button>

      {!isNew && (
        <button onClick={() => setConfirm({ text: "Excluir este atendimento, as receitas e todos os arquivos?", yes: async () => { setConfirm(null); setBusy(true); try { await onDelete(); } finally { setBusy(false); } } })}
          style={{ width: "100%", minHeight: 48, borderRadius: 14, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", color: RED, fontSize: fs(14), fontWeight: 600, cursor: "pointer", marginBottom: 24 }}>
          Excluir atendimento
        </button>
      )}

      {viewer && <FileViewer file={viewer} fs={fs} onClose={() => setViewer(null)} />}

      {fileMenu && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={() => setFileMenu(null)}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: "20px 20px 0 0", padding: 16, width: "100%", maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: fs(14), fontWeight: 600, marginBottom: 10, wordBreak: "break-word", color: "var(--color-text-primary)" }}>{fileMenu.file.name}</div>
            {[
              { txt: "✏️ Renomear", on: () => setRenomear({ target: fileMenu.target, file: fileMenu.file, texto: fileMenu.file.name }), show: true },
              { txt: "↻ Girar 90°", on: () => girar(fileMenu.target, fileMenu.file), show: fileMenu.file.type.startsWith("image/") },
              { txt: "📎 Trocar por outro arquivo", on: () => onPickFile(fileMenu.target, fileMenu.file.id), show: true },
              { txt: "📷 Trocar por uma nova foto", on: () => onPickCamera(fileMenu.target, fileMenu.file.id), show: true },
            ].filter((o) => o.show).map((o) => (
              <button key={o.txt} onClick={() => { setFileMenu(null); o.on(); }}
                style={{ width: "100%", minHeight: 52, textAlign: "left", padding: "0 14px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: fs(15), cursor: "pointer", marginBottom: 8 }}>{o.txt}</button>
            ))}
            <button onClick={() => setFileMenu(null)} style={{ width: "100%", minHeight: 46, border: "none", background: "transparent", color: "var(--color-text-secondary)", fontSize: fs(14), cursor: "pointer" }}>Cancelar</button>
          </div>
        </div>
      )}

      {renomear && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10002, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setRenomear(null)}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 20, padding: 20, width: "88%", maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: fs(15), fontWeight: 600, marginBottom: 10, color: "var(--color-text-primary)" }}>Novo nome do arquivo</div>
            <input value={renomear.texto} onChange={(e) => setRenomear({ ...renomear, texto: e.target.value })} style={{ ...inputStyle, marginBottom: 14 }} autoFocus />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setRenomear(null)} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(14), color: "var(--color-text-primary)" }}>Cancelar</button>
              <button onClick={salvarNome} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "none", background: ACCENT, color: "#fff", fontWeight: 700, cursor: "pointer", fontSize: fs(14) }}>Salvar</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10001, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setConfirm(null)}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 20, padding: 22, width: "88%", maxWidth: 340 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: fs(15), fontWeight: 600, marginBottom: 18, textAlign: "center", color: "var(--color-text-primary)" }}>{confirm.text}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirm(null)} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(14), color: "var(--color-text-primary)" }}>Cancelar</button>
              <button onClick={confirm.yes} style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "none", background: RED, color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: fs(14) }}>Confirmar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tela principal da aba "Atendimentos" ──────────────
export function HealthVisitsView({ scale, onCreateMedication }: { scale: number; onCreateMedication?: (p: MedPrefill) => void }) {
  const { user } = useAuth();
  const fs = (px: number) => Math.round(px * scale * 10) / 10;
  const uid = user?.id ?? "";

  const [unlocked, setUnlocked] = useState<boolean>(() => isUnlocked());
  const [visits, setVisits] = useState<HealthVisit[]>(() => (uid ? loadLocalVisits(uid) : []));
  const [synced, setSynced] = useState<boolean>(() => (uid ? pendingCount(uid) === 0 : true));
  const [editing, setEditing] = useState<{ visit: HealthVisit; isNew: boolean } | null>(null);
  const [dir, setDir] = useState<HealthDirectory>(() => (uid ? loadDirectory(uid) : { places: [], doctors: [] }));

  // Tranca sozinho depois de 2 minutos sem mexer (e ao voltar de outro app)
  useEffect(() => {
    const check = () => { if (!isUnlocked()) setUnlocked(false); };
    const timer = setInterval(check, 10_000);
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Ao abrir (e quando a internet volta): envia o que ficou pendente e baixa a lista
  useEffect(() => {
    if (!unlocked || !uid) return;
    let alive = true;
    const run = async () => {
      const r = await refreshVisits(uid);
      if (alive) { setVisits(r.visits); setSynced(r.synced); }
      const d = await refreshDirectory(uid, r.visits);
      if (alive) setDir(d);
    };
    run();
    window.addEventListener("online", run);
    return () => {
      alive = false;
      window.removeEventListener("online", run);
    };
  }, [unlocked, uid]);

  const suggestions = useMemo(() => {
    const uniq = (xs: string[]) => Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean)));
    const meds = new Map<string, RxItem>();
    for (const v of visits) {
      for (const p of v.prescriptions) {
        for (const it of p.items) {
          const key = it.name.trim().toLowerCase();
          if (key && !meds.has(key)) meds.set(key, it); // a lista vem do mais novo para o mais antigo
        }
      }
    }
    return { doctors: uniq(visits.map((v) => v.doctor_name)), places: uniq([...dir.places.map((p) => p.name), ...visits.flatMap((v) => [v.place_name, ...v.exams.map((e) => e.place), ...v.referrals.map((r) => r.place), ...v.procedures.map((p) => p.place)])]), meds: Array.from(meds.values()) };
  }, [visits, dir]);

  if (!user) return null;

  if (!unlocked) {
    return <LockGate email={user.email ?? null} fs={fs} onUnlocked={() => { markUnlocked(); setUnlocked(true); }} />;
  }

  const mudarDir = (d: HealthDirectory) => {
    setDir(d);
    void saveDirectory(uid, d);
  };

  const handleSave = async (v: HealthVisit, removed: HealthFile[]) => {
    const list = await saveVisit(uid, v);
    if (removed.length) await deleteHealthFiles(removed);
    setVisits(list);
    setSynced(pendingCount(uid) === 0);
    setEditing(null);
    toast({ title: "✅ Atendimento salvo!", description: pendingCount(uid) === 0 ? undefined : "Vai para a nuvem quando houver internet." });
  };

  const handleDelete = async () => {
    if (!editing) return;
    const list = await removeVisit(uid, editing.visit.id);
    setVisits(list);
    setSynced(pendingCount(uid) === 0);
    setEditing(null);
    toast({ title: "Atendimento excluído" });
  };

  const keepAlive = () => touchActivity();

  if (editing) {
    return (
      <div onPointerDown={keepAlive} onKeyDown={keepAlive} onScroll={keepAlive}>
        <VisitEditor
          key={editing.visit.id}
          initial={editing.visit}
          isNew={editing.isNew}
          userId={uid}
          suggestions={suggestions}
          dir={dir}
          onDirChange={mudarDir}
          scale={scale}
          onSave={handleSave}
          onDelete={handleDelete}
          onClose={() => setEditing(null)}
          onCreateMedication={onCreateMedication}
        />
      </div>
    );
  }

  return (
    <div onPointerDown={keepAlive} onKeyDown={keepAlive}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8 }}>
        <span style={{ fontSize: fs(12), padding: "4px 10px", borderRadius: 20, background: synced ? "#E1F5EE" : "#FAEEDA", color: synced ? "#085041" : "#633806", fontWeight: 600 }}>
          {synced ? "☁️ Sincronizado" : "⏳ Aguardando internet"}
        </span>
        <button onClick={() => { lockNow(); setUnlocked(false); }}
          style={{ minHeight: 44, padding: "0 14px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(13), color: "var(--color-text-primary)" }}>
          🔒 Trancar
        </button>
      </div>

      <button onClick={() => setEditing({ visit: newVisit(), isNew: true })}
        style={{ width: "100%", minHeight: 54, borderRadius: 14, border: "none", background: ACCENT, color: "#fff", fontSize: fs(15), fontWeight: 700, cursor: "pointer", marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
        <Plus size={18} /> Novo atendimento
      </button>

      {visits.length === 0 ? (
        <div style={{ textAlign: "center", padding: "36px 16px", color: "var(--color-text-secondary)" }}>
          <div style={{ fontSize: 44, marginBottom: 10 }}>🩺</div>
          <div style={{ fontSize: fs(15), fontWeight: 600 }}>Nenhum atendimento ainda</div>
          <div style={{ fontSize: fs(13), marginTop: 4 }}>Guarde aqui o médico, o local e as receitas de cada consulta.</div>
        </div>
      ) : (
        visits.map((v) => {
          const summary = visitSummary(v);
          const waiting = v.exams.filter((e) => e.resultFiles.length === 0).length;
          return (
            <button key={v.id} onClick={() => setEditing({ visit: v, isNew: false })}
              style={{ display: "block", width: "100%", textAlign: "left", background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 16, padding: 14, marginBottom: 10, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: fs(15), fontWeight: 700, color: "var(--color-text-primary)" }}>{fmtDate(v.visit_date)}</span>
                <span style={{ fontSize: fs(12), color: "var(--color-text-secondary)" }}>
                  {summary}
                </span>
              </div>
              <div style={{ fontSize: fs(14), color: "var(--color-text-primary)", wordBreak: "break-word" }}>
                {[v.place_type, v.place_name].filter(Boolean).join(" · ") || "Local não informado"}
              </div>
              {v.doctor_name && <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginTop: 2 }}>Dr(a). {v.doctor_name}{v.doctor_crm ? ` · ${rotuloCrm(v.doctor_crm)}` : ""}</div>}
              {v.reason && <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginTop: 2, wordBreak: "break-word" }}>{v.reason}</div>}
              {(() => {
                const itens = v.prescriptions.flatMap((pr) => pr.items).filter((it) => it.name.trim());
                if (itens.length === 0) return null;
                return (
                  <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", marginTop: 10, paddingTop: 10 }}>
                    {itens.map((it) => {
                      const l = linhasRemedio(it);
                      return (
                        <div key={it.id} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: fs(16) }}>💊</span>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: fs(14), fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{l.linha1}</div>
                            {l.linha2 && <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", wordBreak: "break-word" }}>{l.linha2}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
              {waiting > 0 && (
                <div style={{ marginTop: 6 }}>
                  <span style={{ fontSize: fs(12), fontWeight: 600, padding: "4px 10px", borderRadius: 20, background: "#FAEEDA", color: "#633806" }}>
                    ⏳ {waiting} {waiting === 1 ? "exame sem resultado" : "exames sem resultado"}
                  </span>
                </div>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
