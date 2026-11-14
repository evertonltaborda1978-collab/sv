import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Plus, Trash2, Pencil, X } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { ALERT_SOUND_OPTIONS, playAlertSoundPreview, type AlertSoundId } from "@/lib/alertSound";
import { NativeAlarmSoundPicker, type NativeSoundValue } from "./NativeAlarmSoundPicker";
import { HealthVisitsView } from "./HealthVisitsView";
import { HealthBackupPanel } from "./HealthBackupPanel";
import type { MedPrefill } from "@/lib/healthLink";
import { FamilyView } from "./FamilyView";
import { useFamilyLinks } from "@/hooks/useFamilyLinks";
import { queuePush } from "@/lib/familyShare";
import { getDoseStatus, getPhaseOnDate } from "@/lib/medicationSchedule";
import { applyDose, buildDay, ensureLog, freeSlotsFor, parseDay, pickLiveSlot, resolveAt, stockForecast, treatmentStats, type DaySlot } from "@/lib/doseLog";
import { getCurrentPhaseIndex, getDaysElapsed, type MedOrigin, type MedPhase, type Medication } from "@/lib/medicationTypes";
export type { Medication } from "@/lib/medicationTypes";

// ── Tipos e constantes ────────────────────────────────
interface FamilyProfile {
  id: string;
  name: string;
  icon: string;
}

type MedType = Medication["type"];

const TYPE_MAP: Record<MedType, { icon: string; label: string; short: string }> = {
  pill: { icon: "💊", label: "Comprimido", short: "Comp." },
  liquid: { icon: "🧴", label: "Xarope/Líquido", short: "Xarope" },
  injection: { icon: "💉", label: "Injeção", short: "Injeção" },
  topical: { icon: "🩹", label: "Pomada/Externo", short: "Pomada" },
  powder: { icon: "🧂", label: "Pó/Sachê", short: "Pó" },
};

// Doses disponíveis na rolagem, de acordo com o tipo de uso
const DOSE_CONFIG: Record<MedType, { unit: string; short: string; values: number[] }> = {
  pill: { unit: "comprimido", short: "comp.", values: [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5] },
  liquid: { unit: "ml", short: "ml", values: [1, 2, 2.5, 3, 4, 5, 7.5, 10, 12.5, 15, 20, 25, 30] },
  injection: { unit: "ml", short: "ml", values: [0.5, 1, 1.5, 2, 2.5, 3, 4, 5] },
  topical: { unit: "aplicação", short: "apl.", values: [1, 2, 3, 4] },
  powder: { unit: "sachê", short: "sachê", values: [0.5, 1, 2, 3, 4] },
};

// O 0 vem primeiro: um medicamento novo começa zerado e você escolhe cada valor.
const DAYS_OPTIONS: number[] = [0, ...Array.from({ length: 60 }, (_, i) => i + 1), 70, 80, 90, 120, 180];
const TIMES_OPTIONS: number[] = Array.from({ length: 13 }, (_, i) => i);

const COLORS = ["#1D9E75", "#378ADD", "#EF9F27", "#D85A30", "#9C27B0", "#E24B4A"];
const PROFILE_ICONS = ["👨", "👩", "👦", "👧", "👴", "👵"];

// Tamanhos de fonte: 1.0 = tamanho antigo. O padrão agora é o 4º (1.3).
const FONT_STEPS = [0.9, 1.0, 1.15, 1.3, 1.55, 1.8];
const DEFAULT_FONT_STEP = 3;
const FONT_STORAGE_KEY = "med_font_step";

type TrashedMedication = Medication & { deletedAt: string };
const TRASH_DAYS = 30;

// Destaque piscante no nome do remédio: amarelo (dose em até 1h), vermelho (atrasada), verde (acabou de tomar)
const WHEEL_CSS = `.med-wheel{scrollbar-width:none;-ms-overflow-style:none}.med-wheel::-webkit-scrollbar{display:none}
/* Cores da aba Saúde: ligadas ao tema do app (claro e escuro). Antes estas variáveis não existiam no app e as janelas ficavam transparentes. */
.saude-root{--color-background-primary:hsl(var(--card));--color-background-secondary:hsl(var(--muted));--color-background-tertiary:hsl(var(--secondary));--color-text-primary:hsl(var(--foreground));--color-text-secondary:hsl(var(--muted-foreground));--color-border-primary:hsl(var(--foreground) / .35);--color-border-secondary:hsl(var(--foreground) / .24);--color-border-tertiary:hsl(var(--border))}
@keyframes medPulseY{0%,100%{box-shadow:0 0 0 0 rgba(239,159,39,.65)}50%{box-shadow:0 0 0 8px rgba(239,159,39,0)}}
@keyframes medPulseR{0%,100%{box-shadow:0 0 0 0 rgba(226,75,74,.65)}50%{box-shadow:0 0 0 8px rgba(226,75,74,0)}}
@keyframes medPulseG{0%,100%{box-shadow:0 0 0 0 rgba(29,158,117,.65)}50%{box-shadow:0 0 0 8px rgba(29,158,117,0)}}
.med-hl-soon{animation:medPulseY 1.5s ease-in-out infinite}
.med-hl-late{animation:medPulseR 1s ease-in-out infinite}
.med-hl-ok{animation:medPulseG 1.2s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.med-hl-soon,.med-hl-late,.med-hl-ok{animation:none}}`;

function fmtMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── Funções auxiliares ────────────────────────────────
const pad2 = (n: number) => String(n).padStart(2, "0");

// Data LOCAL (YYYY-MM-DD). toISOString() usa UTC e virava o dia às 21h no Brasil.
function localKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function keyOfIso(iso: string): string {
  return localKey(new Date(iso));
}

function fmtDose(v: number): string {
  return String(v).replace(".", ",");
}

function unitLabel(unit: string, dose: number): string {
  if (dose <= 1) return unit;
  if (unit === "ml") return "ml";
  if (unit === "aplicação") return "aplicações";
  return `${unit}s`;
}

function withValue(list: number[], v: number): number[] {
  return list.includes(v) ? list : [...list, v].sort((a, b) => a - b);
}

function nearest(list: number[], v: number): number {
  return list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0]);
}

function generateSchedules(timesPerDay: number, startTime: string): string[] {
  if (timesPerDay <= 0) return [];
  const [h, m] = startTime.split(":").map(Number);
  const interval = Math.floor(24 / timesPerDay);
  return Array.from({ length: timesPerDay }, (_, i) => {
    const totalMin = (h * 60 + m + i * interval * 60) % (24 * 60);
    return `${pad2(Math.floor(totalMin / 60))}:${pad2(totalMin % 60)}`;
  });
}

function getTotalDays(phases: MedPhase[]): number {
  return phases.reduce((sum, p) => sum + p.days, 0);
}

function getNextSchedule(phases: MedPhase[], currentPhase: number): string {
  const phase = phases[currentPhase];
  if (!phase) return "--";
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const t of phase.schedules) {
    const [h, m] = t.split(":").map(Number);
    if (h * 60 + m > nowMin) return t;
  }
  return phase.schedules[0] || "--";
}

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function dayLabel(day: string, todayKey: string): string {
  const d = parseDay(day);
  const dd = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;
  if (day === todayKey) return `Hoje ${dd}`;
  const y = parseDay(todayKey);
  y.setDate(y.getDate() - 1);
  if (day === localKey(y)) return `Ontem ${dd}`;
  return `${WEEKDAYS[d.getDay()]} ${dd}`;
}

function fmtHM(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtNum(n: number): string {
  return String(Math.round(n * 100) / 100).replace(".", ",");
}

// ── Rolagem (picker) ──────────────────────────────────
// Celular: rolagem nativa com "imã" (snap). Computador: roda do mouse (1 número
// por clique da roda), arrastar com o mouse, clicar no número e setas ↑ ↓.
function WheelPicker({
  options, value, onChange, format, color, scale, ariaLabel,
}: {
  options: number[];
  value: number;
  onChange: (v: number) => void;
  format?: (n: number) => string;
  color: string;
  scale: number;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolling = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ options, value, onChange });
  latest.current = { options, value, onChange };
  const drag = useRef<{ y: number; top: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const lastWheel = useRef(0);
  const fsz = (px: number) => Math.round(px * scale * 10) / 10;
  const itemH = Math.max(44, Math.round(fsz(20) * 2));
  const mask = "linear-gradient(to bottom, transparent 0%, #000 28%, #000 72%, transparent 100%)";

  const markScrolling = (ms: number) => {
    scrolling.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { scrolling.current = false; }, ms);
  };

  const selectIndex = (i: number) => {
    const { options: opts, value: cur, onChange: change } = latest.current;
    const idx = Math.max(0, Math.min(opts.length - 1, i));
    markScrolling(350);
    if (opts[idx] !== cur) change(opts[idx]);
    ref.current?.scrollTo({ top: idx * itemH, behavior: "smooth" });
  };

  const step = (dir: number) => {
    const { options: opts, value: cur } = latest.current;
    selectIndex(Math.max(0, opts.indexOf(cur)) + dir);
  };

  // Posiciona a rolagem no valor atual (abrir o formulário, trocar o tipo, etc.)
  useEffect(() => {
    const el = ref.current;
    if (!el || scrolling.current || drag.current) return;
    const target = Math.max(0, options.indexOf(value)) * itemH;
    if (Math.abs(el.scrollTop - target) > 2) el.scrollTop = target;
  }, [value, itemH, options.length]);

  // Roda do mouse: 1 número por "clique" da roda (precisa ser listener não-passivo)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      const now = Date.now();
      if (now - lastWheel.current < 80) return;
      lastWheel.current = now;
      step(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [itemH]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    markScrolling(160);
    const { options: opts, value: cur, onChange: change } = latest.current;
    const idx = Math.max(0, Math.min(opts.length - 1, Math.round(el.scrollTop / itemH)));
    if (opts[idx] !== cur) {
      change(opts[idx]);
      try { navigator.vibrate?.(6); } catch {}
    }
  };

  // Arrastar com o mouse (no celular o dedo já rola sozinho)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    drag.current = { y: e.clientY, top: ref.current?.scrollTop ?? 0, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) > 4) {
      d.moved = true;
      el.style.scrollSnapType = "none";
      try { el.setPointerCapture(d.id); } catch {}
    }
    if (d.moved) el.scrollTop = d.top - dy;
  };
  const endDrag = () => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el || !d.moved) return;
    suppressClick.current = true;
    window.setTimeout(() => { suppressClick.current = false; }, 0);
    el.style.scrollSnapType = "y mandatory";
    selectIndex(Math.round(el.scrollTop / itemH));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
  };

  return (
    <div style={{ position: "relative", height: itemH * 3, width: "100%" }} role="listbox" aria-label={ariaLabel}>
      <div style={{
        position: "absolute", left: 2, right: 2, top: itemH, height: itemH, borderRadius: 12,
        background: `${color}1A`, border: `1.5px solid ${color}66`, pointerEvents: "none",
      }} />
      <div
        ref={ref}
        className="med-wheel"
        tabIndex={0}
        onScroll={handleScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        style={{
          height: "100%", overflowY: "scroll", scrollSnapType: "y mandatory",
          overscrollBehavior: "contain", WebkitOverflowScrolling: "touch", touchAction: "pan-y",
          WebkitMaskImage: mask, maskImage: mask, cursor: "grab", userSelect: "none", outline: "none",
        }}
      >
        <div style={{ height: itemH }} />
        {options.map((o, i) => {
          const selected = o === value;
          return (
            <div
              key={o}
              role="option"
              aria-selected={selected}
              onClick={() => {
                if (suppressClick.current) { suppressClick.current = false; return; }
                selectIndex(i);
              }}
              style={{
                height: itemH, scrollSnapAlign: "center", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: fsz(selected ? 22 : 17), fontWeight: selected ? 700 : 400,
                color: selected ? color : "var(--color-text-secondary)",
                cursor: "pointer", userSelect: "none",
              }}
            >
              {format ? format(o) : o}
            </div>
          );
        })}
        <div style={{ height: itemH }} />
      </div>
    </div>
  );
}

// ── Contador +/- (estoque) — dá para digitar o número direto ──
function Stepper({ value, onChange, min, scale }: { value: number; onChange: (v: number) => void; min: number; scale: number }) {
  const sz = (px: number) => Math.round(px * scale * 10) / 10;
  const btn: React.CSSProperties = {
    width: 42, height: 44, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)",
    background: "transparent", cursor: "pointer", fontSize: sz(22), color: "var(--color-text-primary)", padding: 0,
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} style={btn} aria-label="Diminuir">−</button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        value={value}
        onFocus={e => e.target.select()}
        onChange={e => {
          const n = parseInt(e.target.value, 10);
          onChange(Number.isNaN(n) ? min : Math.max(min, n));
        }}
        style={{ width: 52, height: 44, textAlign: "center", fontSize: sz(18), fontWeight: 600, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", padding: 0 }}
      />
      <button type="button" onClick={() => onChange(value + 1)} style={btn} aria-label="Aumentar">+</button>
    </div>
  );
}

// ── Componente principal ──────────────────────────────
export function MedicationView() {
  const { user } = useAuth();
  const [profiles, setProfiles] = useState<FamilyProfile[]>([{ id: "default", name: "Eu", icon: "👨" }]);
  const [activeProfile, setActiveProfile] = useState("default");
  const [medications, setMedications] = useState<Medication[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState<string | null>(null);
  const [slotSheet, setSlotSheet] = useState<{ medId: string; day: string; slot: number } | null>(null);
  const [slotTime, setSlotTime] = useState("08:00");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileIcon, setNewProfileIcon] = useState("👨");
  const [showSizePanel, setShowSizePanel] = useState(false);
  const [showBackupPanel, setShowBackupPanel] = useState(false);
  const [tab, setTab] = useState<"remedios" | "atendimentos" | "familia">("remedios");
  const [medsLoaded, setMedsLoaded] = useState(false);
  const { links, refresh: refreshLinks } = useFamilyLinks(user?.id);
  const sharingActive = links.some(l => l.owner_id === user?.id && l.status === "accepted");
  const [trash, setTrash] = useState<TrashedMedication[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null);
  // Relógio da tela: atualiza a cada 15s para o destaque do nome (amarelo/vermelho/verde) acompanhar a hora
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  // Tamanho da fonte (salvo no aparelho)
  const [fontStep, setFontStep] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(FONT_STORAGE_KEY);
      const n = raw == null ? NaN : parseInt(raw, 10);
      return n >= 0 && n < FONT_STEPS.length ? n : DEFAULT_FONT_STEP;
    } catch { return DEFAULT_FONT_STEP; }
  });
  const scale = FONT_STEPS[fontStep];
  const fs = (px: number) => Math.round(px * scale * 10) / 10;
  const chooseFont = (i: number) => {
    setFontStep(i);
    try { localStorage.setItem(FONT_STORAGE_KEY, String(i)); } catch {}
  };

  // Estado do formulário
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState<MedType>("pill");
  const [formColor, setFormColor] = useState(COLORS[0]);
  const [formStock, setFormStock] = useState(0);
  const [formLowStock, setFormLowStock] = useState(0);
  const [formStartDate, setFormStartDate] = useState(localKey());
  const [formPhases, setFormPhases] = useState<MedPhase[]>([
    { dose: 0, doseUnit: "comprimido", days: 0, timesPerDay: 0, startTime: "08:00", schedules: [] },
  ]);
  const [formSound, setFormSound] = useState<AlertSoundId | null>(null);
  const [formNativeSound, setFormNativeSound] = useState<NativeSoundValue>({ uri: null, name: null });
  const [formOrigin, setFormOrigin] = useState<MedOrigin | null>(null);

  const STORAGE_KEY = `medications_${user?.id}`;
  const TRASH_KEY = `medications_trash_${user?.id}`;

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setMedications(JSON.parse(raw));
      const rawT = localStorage.getItem(TRASH_KEY);
      if (rawT) {
        const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
        const all: TrashedMedication[] = JSON.parse(rawT);
        const kept = all.filter(t => new Date(t.deletedAt).getTime() > cutoff);
        setTrash(kept);
        if (kept.length !== all.length) localStorage.setItem(TRASH_KEY, JSON.stringify(kept));
      }
      const rawP = localStorage.getItem(`profiles_${user?.id}`);
      if (rawP) setProfiles(JSON.parse(rawP));
    } catch {}
    if (user) setMedsLoaded(true);
  }, [user]);

  // Se alguém acompanha esta conta, envia a foto atual dos remédios ao abrir a Saúde
  useEffect(() => {
    if (user && medsLoaded && sharingActive) queuePush(user.id, medications);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medsLoaded, sharingActive]);

  const save = useCallback((meds: Medication[]) => {
    setMedications(meds);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(meds)); } catch {}
    // Avisa o app (Index.tsx) pra reagendar os alarmes dos remédios na hora
    try { window.dispatchEvent(new Event("medications-changed")); } catch {}
    if (user) queuePush(user.id, meds);
  }, [STORAGE_KEY, user]);

  const saveProfiles = useCallback((profs: FamilyProfile[]) => {
    setProfiles(profs);
    try { localStorage.setItem(`profiles_${user?.id}`, JSON.stringify(profs)); } catch {}
  }, [user]);

  const profileMeds = useMemo(
    () => medications.filter(m => m.profileId === activeProfile),
    [medications, activeProfile]
  );

  // ── Formulário: fases ──
  const updatePhase = (idx: number, patch: Partial<MedPhase>) => {
    setFormPhases(prev => prev.map((p, i) => {
      if (i !== idx) return p;
      const n = { ...p, ...patch };
      if ("timesPerDay" in patch || "startTime" in patch) {
        n.schedules = generateSchedules(n.timesPerDay, n.startTime);
      }
      return n;
    }));
  };

  const addPhase = () => {
    if (formPhases.length >= 4) return;
    const cfg = DOSE_CONFIG[formType];
    const last = formPhases[formPhases.length - 1];
    setFormPhases(prev => [...prev, {
      dose: 0,
      doseUnit: cfg.unit,
      days: 0,
      timesPerDay: 0,
      startTime: last ? last.startTime : "08:00",
      schedules: [],
    }]);
  };

  const removePhase = (idx: number) => {
    setFormPhases(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

  const changeType = (key: MedType) => {
    if (key === formType) return;
    setFormType(key);
    const cfg = DOSE_CONFIG[key];
    setFormPhases(prev => prev.map(p => ({ ...p, doseUnit: cfg.unit, dose: p.dose === 0 ? 0 : nearest(cfg.values, p.dose) })));
  };

  const resetForm = () => {
    setEditingId(null);
    setFormName(""); setFormType("pill"); setFormColor(COLORS[0]);
    setFormStock(0); setFormLowStock(0);
    setFormStartDate(localKey());
    setFormPhases([{ dose: 0, doseUnit: "comprimido", days: 0, timesPerDay: 0, startTime: "08:00", schedules: [] }]);
    setFormSound(null);
    setFormNativeSound({ uri: null, name: null });
    setFormOrigin(null);
  };

  const openNew = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (med: Medication) => {
    setEditingId(med.id);
    setFormName(med.name);
    setFormType(med.type);
    setFormColor(med.color);
    setFormStock(med.stock);
    setFormLowStock(med.lowStockAlert);
    setFormStartDate(med.startDate);
    setFormPhases(med.phases.map(p => ({ ...p, schedules: [...p.schedules] })));
    setFormSound((med.alertSound as AlertSoundId | null) ?? null);
    setFormNativeSound({ uri: med.nativeSoundUri ?? null, name: med.nativeSoundName ?? null });
    setFormOrigin(med.origin ?? null);
    setShowForm(true);
  };

  // Vindo de uma receita (aba Atendimentos): abre o cadastro já com nome, tipo e estoque
  const startFromPrescription = (p: MedPrefill) => {
    resetForm();
    setTab("remedios");
    setFormName(p.name);
    setFormType(p.type);
    setFormStock(p.stock);
    setFormPhases([{ dose: 0, doseUnit: DOSE_CONFIG[p.type].unit, days: 0, timesPerDay: 0, startTime: "08:00", schedules: [] }]);
    setFormOrigin(p.origin);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    resetForm();
  };

  const handleSave = () => {
    if (!formName.trim()) { toast({ title: "Informe o nome do medicamento" }); return; }
    const badPhase = formPhases.findIndex(p => !(p.dose > 0 && p.days > 0 && p.timesPerDay > 0));
    if (badPhase >= 0) {
      toast({ title: `Preencha a Fase ${badPhase + 1}`, description: "Escolha a dose, os dias e as vezes por dia (não podem ficar em 0).", variant: "destructive" });
      return;
    }
    // "Som do sistema" / "Música do celular" já valem como escolha de som.
    const effectiveSound: AlertSoundId | null = formSound ?? (formNativeSound.uri ? "classico" : null);
    if (!effectiveSound) { toast({ title: "Escolha um som de alerta", description: "Toque numa das opções, ou use Som do sistema / Música do celular.", variant: "destructive" }); return; }

    if (editingId) {
      const existing = medications.find(m => m.id === editingId);
      if (existing) {
        const updated: Medication = {
          ...existing,
          name: formName.trim(),
          type: formType,
          phases: formPhases,
          currentPhase: Math.min(existing.currentPhase, formPhases.length - 1),
          startDate: formStartDate,
          stock: formStock,
          lowStockAlert: formLowStock,
          color: formColor,
          alertSound: effectiveSound,
          nativeSoundUri: formNativeSound.uri,
          nativeSoundName: formNativeSound.name,
          origin: formOrigin ?? undefined,
        };
        save(medications.map(m => (m.id === editingId ? updated : m)));
        closeForm();
        toast({ title: "✅ Medicamento atualizado!" });
        return;
      }
    }

    const newMed: Medication = {
      id: crypto.randomUUID(),
      profileId: activeProfile,
      name: formName.trim(),
      type: formType,
      phases: formPhases,
      currentPhase: 0,
      startDate: formStartDate,
      stock: formStock,
      lowStockAlert: formLowStock,
      color: formColor,
      takenDates: [],
      alertSound: effectiveSound,
      nativeSoundUri: formNativeSound.uri,
      nativeSoundName: formNativeSound.name,
      origin: formOrigin ?? undefined,
    };
    save([...medications, newMed]);
    closeForm();
    toast({ title: "✅ Medicamento adicionado!" });
  };

  // ── Ações da lista ──
  const takeMed = (id: string) => {
    const med = medications.find(m => m.id === id);
    if (!med) return;
    const phase = med.phases[getCurrentPhaseIndex(med.phases, med.startDate)];
    const now = new Date();
    const pick = pickLiveSlot(med, now, phase);
    if (!pick) { toast({ title: "Todas as doses de hoje já têm marcação" }); return; }
    const updated = applyDose(med, pick.day, pick.slot, { kind: "taken", at: now, late: false }, pick.phase);
    save(medications.map(m => (m.id === id ? updated : m)));
    setClock(new Date());
    toast({ title: "✅ Dose registrada!", description: med.stock > 0 || updated.stock > 0 ? `Restam ${fmtNum(updated.stock)} no estoque.` : undefined });
  };

  const undoLastDose = (id: string) => {
    const med = medications.find(m => m.id === id);
    if (!med) return;
    const today = localKey();
    const mine = ensureLog(med)
      .filter(e => e.kind === "taken" && !e.late && keyOfIso(e.at) === today)
      .sort((a, b) => a.at.localeCompare(b.at));
    const last = mine[mine.length - 1];
    if (!last) return;
    const updated = applyDose(med, last.day, last.slot, { kind: "clear" }, null);
    save(medications.map(m => (m.id === id ? updated : m)));
    setClock(new Date());
    toast({ title: "Dose desfeita", description: med.stock > 0 || updated.stock > 0 ? `Restam ${fmtNum(updated.stock)} no estoque.` : undefined });
  };

  // Janelinha de uma dose (tocar numa bolinha): corrigir, "não tomei" ou deixar sem registro
  const openSlot = (medId: string, day: string, slot: number) => {
    const med = medications.find(m => m.id === medId);
    if (!med) return;
    const d = buildDay(med, day, clock, med.phases[getCurrentPhaseIndex(med.phases, med.startDate)]);
    const s = d.slots.find(x => x.slot === slot);
    if (!s) return;
    setSlotTime(s.entry?.kind === "taken" ? fmtHM(s.entry.at) : s.label);
    setSlotSheet({ medId, day, slot });
  };

  const applySlot = (kind: "taken" | "skipped" | "clear") => {
    if (!slotSheet) return;
    const med = medications.find(m => m.id === slotSheet.medId);
    if (!med) { setSlotSheet(null); return; }
    const fallback = med.phases[getCurrentPhaseIndex(med.phases, med.startDate)];
    const d = buildDay(med, slotSheet.day, clock, fallback);
    if (!d.phase) { setSlotSheet(null); return; }
    const prev = d.slots.find(x => x.slot === slotSheet.slot)?.entry;
    const action = kind === "taken"
      ? ({ kind: "taken", at: resolveAt(slotSheet.day, slotTime, d.phase, slotSheet.slot), late: prev?.kind === "taken" ? !!prev.late : true } as const)
      : kind === "skipped" ? ({ kind: "skipped" } as const) : ({ kind: "clear" } as const);
    const updated = applyDose(med, slotSheet.day, slotSheet.slot, action, d.phase);
    save(medications.map(m => (m.id === med.id ? updated : m)));
    setClock(new Date());
    setSlotSheet(null);
    toast({
      title: kind === "taken" ? "✅ Dose registrada" : kind === "skipped" ? "Marcada como não tomada" : "Voltou para sem registro",
      description: med.stock > 0 || updated.stock > 0 ? `Restam ${fmtNum(updated.stock)} no estoque.` : undefined,
    });
  };

  const saveTrash = (list: TrashedMedication[]) => {
    setTrash(list);
    try { localStorage.setItem(TRASH_KEY, JSON.stringify(list)); } catch {}
  };

  // Excluir = mover para a lixeira (dá para restaurar por 30 dias). Os alarmes dele param.
  const moveToTrash = (id: string) => {
    const med = medications.find(m => m.id === id);
    if (!med) return;
    saveTrash([...trash, { ...med, deletedAt: new Date().toISOString() }]);
    save(medications.filter(m => m.id !== id));
    setConfirmDeleteId(null);
    toast({ title: "Movido para a lixeira", description: `Você pode restaurar em até ${TRASH_DAYS} dias.` });
  };

  const restoreFromTrash = (id: string) => {
    const item = trash.find(t => t.id === id);
    if (!item) return;
    const med = { ...item } as Medication & { deletedAt?: string };
    delete med.deletedAt;
    save([...medications, med]);
    saveTrash(trash.filter(t => t.id !== id));
    toast({ title: "✅ Medicamento restaurado" });
  };

  const purgeFromTrash = (id: string) => {
    saveTrash(trash.filter(t => t.id !== id));
    setConfirmPurgeId(null);
    toast({ title: "Excluído de vez" });
  };

  const addProfile = () => {
    if (!newProfileName.trim() || profiles.length >= 5) return;
    const newP: FamilyProfile = { id: crypto.randomUUID(), name: newProfileName, icon: newProfileIcon };
    saveProfiles([...profiles, newP]);
    setShowAddProfile(false);
    setNewProfileName("");
  };

  // Doses de hoje: marcadas ÷ previstas (de todos os remédios ativos hoje)
  const todayKeyNow = localKey(clock);
  let todayPlanned = 0;
  let todayTaken = 0;
  for (const m of profileMeds) {
    const ph = getPhaseOnDate(m, clock);
    if (!ph) continue;
    todayPlanned += ph.timesPerDay;
    todayTaken += ensureLog(m).filter(e => e.day === todayKeyNow && e.kind === "taken").length;
  }

  const upcoming = profileMeds.filter(m => {
    const next = getNextSchedule(m.phases, getCurrentPhaseIndex(m.phases, m.startDate));
    const [h] = next.split(":").map(Number);
    const nowH = new Date().getHours();
    return h >= nowH && h <= nowH + 3;
  }).length;

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "11px 12px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)",
    fontSize: fs(15), background: "transparent", color: "var(--color-text-primary)",
  };
  const labelStyle: React.CSSProperties = { fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 };

  // ══════════════════════════════════════════════════════
  // FORMULÁRIO (novo / editar) — página inteira
  // ══════════════════════════════════════════════════════
  if (showForm) {
    const cfg = DOSE_CONFIG[formType];
    return (
      <div className="saude-root" style={{ minHeight: "60vh" }}>
        <style>{WHEEL_CSS}</style>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <button
            onClick={closeForm}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", fontSize: fs(14), fontWeight: 500, padding: "10px 0", minHeight: 44 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
            Voltar
          </button>
          <div style={{ fontSize: fs(17), fontWeight: 600, color: "var(--color-text-primary)" }}>
            {editingId ? "Editar medicamento" : "Novo medicamento"}
          </div>
          <div style={{ width: 60 }} />
        </div>

        {formOrigin && (
          <div style={{ background: "#E1F5EE", border: "0.5px solid #1D9E75", borderRadius: 12, padding: "10px 12px", marginBottom: 14, fontSize: fs(13), color: "#085041" }}>
            📋 {formOrigin.label}
            <div style={{ fontSize: fs(12), marginTop: 2 }}>Falta escolher dose, dias e vezes por dia.</div>
          </div>
        )}

        {/* Prévia */}
        {formName && (
          <div style={{ background: `${formColor}15`, border: `0.5px solid ${formColor}40`, borderRadius: 14, padding: 12, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 44, height: 44, borderRadius: "50%", background: `${formColor}25`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: fs(22), lineHeight: 1 }}>
              {TYPE_MAP[formType].icon}
            </div>
            <div>
              <div style={{ fontSize: fs(15), fontWeight: 600, color: "var(--color-text-primary)" }}>{formName}</div>
              <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)" }}>{TYPE_MAP[formType].label}</div>
            </div>
          </div>
        )}

        {/* Nome */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Nome</div>
          <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Ex: Losartana 50mg" style={inputStyle} />
        </div>

        {/* Tipo */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Tipo de uso</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
            {(Object.entries(TYPE_MAP) as [MedType, typeof TYPE_MAP[MedType]][]).map(([key, val]) => (
              <button key={key} onClick={() => changeType(key)}
                style={{ padding: "10px 6px", minHeight: 62, borderRadius: 12, border: `1.5px solid ${formType === key ? "#1A1A2E" : "var(--color-border-secondary)"}`, background: formType === key ? "#1A1A2E" : "transparent", color: formType === key ? "white" : "var(--color-text-primary)", fontSize: fs(12), cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, fontWeight: formType === key ? 600 : 400 }}>
                <span style={{ fontSize: fs(20), lineHeight: 1 }}>{val.icon}</span>
                <span>{val.short}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Cor */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Cor</div>
          <div style={{ display: "flex", gap: 8 }}>
            {COLORS.map(c => (
              <button key={c} onClick={() => setFormColor(c)} aria-label={`Cor ${c}`}
                style={{ width: 36, height: 36, borderRadius: "50%", background: c, border: formColor === c ? "3px solid #1A1A2E" : "none", cursor: "pointer" }} />
            ))}
          </div>
        </div>

        {/* Data início */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Data de início</div>
          <input type="date" value={formStartDate} onChange={e => setFormStartDate(e.target.value)} style={inputStyle} />
        </div>

        {/* Fases */}
        <div style={{ marginBottom: 14 }}>
          <div style={labelStyle}>Fases da prescrição ({formPhases.length}/4) · roda do mouse, arrastar ou deslizar</div>
          {formPhases.map((phase, idx) => {
            const pc = COLORS[idx % COLORS.length];
            return (
              <div key={idx} style={{ background: "var(--color-background-secondary)", borderRadius: 16, padding: 12, marginBottom: 10, border: `0.5px solid ${pc}40` }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, minHeight: 40 }}>
                  <div style={{ fontSize: fs(15), fontWeight: 600, color: pc }}>
                    Fase {idx + 1}{phase.days > 0 ? ` · ${phase.days} ${phase.days === 1 ? "dia" : "dias"}` : ""}
                  </div>
                  {formPhases.length > 1 && (
                    <button onClick={() => removePhase(idx)} aria-label={`Excluir fase ${idx + 1}`}
                      style={{ width: 44, height: 44, borderRadius: 12, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <Trash2 size={18} color="#E24B4A" />
                    </button>
                  )}
                </div>

                {/* Dose · Dias · Vezes por dia */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  <div>
                    <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", textAlign: "center", marginBottom: 2 }}>Dose ({cfg.short})</div>
                    <WheelPicker ariaLabel="Dose" options={withValue([0, ...cfg.values], phase.dose)} value={phase.dose}
                      onChange={v => updatePhase(idx, { dose: v, doseUnit: cfg.unit })} format={fmtDose} color={pc} scale={scale} />
                  </div>
                  <div>
                    <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", textAlign: "center", marginBottom: 2 }}>Dias</div>
                    <WheelPicker ariaLabel="Dias de tratamento" options={withValue(DAYS_OPTIONS, phase.days)} value={phase.days}
                      onChange={v => updatePhase(idx, { days: v })} color={pc} scale={scale} />
                  </div>
                  <div>
                    <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", textAlign: "center", marginBottom: 2 }}>Vezes/dia</div>
                    <WheelPicker ariaLabel="Vezes por dia" options={TIMES_OPTIONS} value={phase.timesPerDay}
                      onChange={v => updatePhase(idx, { timesPerDay: v })} format={n => `${n}x`} color={pc} scale={scale} />
                  </div>
                </div>
                {phase.timesPerDay > 0 && (
                  <div style={{ fontSize: fs(11), color: "var(--color-text-secondary)", textAlign: "center", marginTop: 2 }}>
                    A cada {Math.round(24 / phase.timesPerDay)}h
                  </div>
                )}

                {/* Horário inicial — relógio do próprio aparelho */}
                <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", textAlign: "center", margin: "10px 0 4px" }}>Horário inicial</div>
                <input
                  type="time"
                  value={phase.startTime}
                  onChange={e => { if (e.target.value) updatePhase(idx, { startTime: e.target.value }); }}
                  style={{ ...inputStyle, display: "block", width: "auto", minWidth: 150, margin: "0 auto", textAlign: "center", fontSize: fs(22), fontWeight: 700, color: pc }}
                />

                <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
                  {phase.schedules.map(s => (
                    <span key={s} style={{ fontSize: fs(12), padding: "3px 10px", borderRadius: 20, background: `${pc}20`, color: pc, fontWeight: 600 }}>{s}</span>
                  ))}
                </div>
              </div>
            );
          })}

          {formPhases.length < 4 && (
            <button onClick={addPhase}
              style={{ width: "100%", padding: 12, minHeight: 48, borderRadius: 12, border: "1px dashed var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", fontSize: fs(13), cursor: "pointer", marginBottom: 8 }}>
              + Adicionar fase
            </button>
          )}

          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginBottom: 4 }}>Prescrição visual</div>
            <div style={{ display: "flex", gap: 2, borderRadius: 4, overflow: "hidden", height: 10 }}>
              {formPhases.map((p, i) => (
                <div key={i} style={{ flex: p.days, background: COLORS[i % COLORS.length] }} />
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              {formPhases.map((p, i) => (
                <span key={i} style={{ fontSize: fs(11), color: COLORS[i % COLORS.length] }}>● Fase {i + 1}: {p.days} dias</span>
              ))}
            </div>
          </div>
        </div>

        {/* Estoque */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
          <div>
            <div style={labelStyle}>{editingId ? "Estoque atual" : "Estoque inicial"}</div>
            <Stepper value={formStock} onChange={setFormStock} min={0} scale={scale} />
          </div>
          <div>
            <div style={labelStyle}>Avisar quando restar (0 = não avisar)</div>
            <Stepper value={formLowStock} onChange={setFormLowStock} min={0} scale={scale} />
          </div>
        </div>

        {/* Som do alerta */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Som do alerta (toque para ouvir e escolher)</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {ALERT_SOUND_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => { setFormSound(opt.id); playAlertSoundPreview(opt.id); }}
                style={{
                  textAlign: "left", padding: "10px 12px", minHeight: 44, borderRadius: 10, fontSize: fs(13), fontWeight: 600, cursor: "pointer",
                  background: formSound === opt.id ? "#1A1A2E" : "rgba(0,0,0,0.05)",
                  color: formSound === opt.id ? "#FFF" : "#555",
                  border: formSound === opt.id ? "none" : "1px solid #E0E0E0",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <NativeAlarmSoundPicker value={formNativeSound} onChange={setFormNativeSound} />
        </div>

        <button onClick={handleSave}
          style={{ width: "100%", padding: 16, minHeight: 54, borderRadius: 14, border: "none", background: "#1A1A2E", color: "white", fontSize: fs(15), fontWeight: 600, cursor: "pointer", marginBottom: 14 }}>
          {editingId ? "Salvar alterações" : "Salvar medicamento"}
        </button>

        <button
          onClick={closeForm}
          style={{ width: "100%", padding: 12, minHeight: 48, borderRadius: 14, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", fontSize: fs(14), fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 20 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
          Voltar para medicamentos
        </button>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════
  // LISTA DE MEDICAMENTOS
  // ══════════════════════════════════════════════════════
  const today = localKey();

  // Uma bolinha por horário: ✅ tomado (hora real), ❌ não tomei, ⚪ sem registro, ○ ainda não chegou
  const renderBubble = (med: Medication, day: string, sl: DaySlot) => {
    const e = sl.entry;
    const look = e?.kind === "taken"
      ? { text: `✅ ${fmtHM(e.at)}`, bg: "#E1F5EE", fg: "#085041", bd: "#1D9E75" }
      : e?.kind === "skipped"
        ? { text: `❌ ${sl.label}`, bg: "#FCEBEB", fg: "#8A1C1B", bd: "#E24B4A" }
        : sl.future
          ? { text: `○ ${sl.label}`, bg: "transparent", fg: "var(--color-text-secondary)", bd: "var(--color-border-tertiary)" }
          : { text: `⚪ ${sl.label}`, bg: "var(--color-background-secondary)", fg: "var(--color-text-primary)", bd: "var(--color-border-secondary)" };
    const locked = sl.future && !e;
    return (
      <button key={sl.slot} onClick={() => openSlot(med.id, day, sl.slot)} disabled={locked}
        aria-label={`Dose das ${sl.label}`}
        style={{ minHeight: 40, padding: "6px 12px", borderRadius: 20, border: `1.5px solid ${look.bd}`, background: look.bg, color: look.fg, fontSize: fs(13), fontWeight: 600, cursor: locked ? "default" : "pointer", opacity: locked ? 0.7 : 1 }}>
        {look.text}
      </button>
    );
  };

  const renderDayRow = (med: Medication, day: string, fallback: MedPhase | null | undefined) => {
    const d = buildDay(med, day, clock, fallback);
    if (!d.phase) return null;
    return (
      <div key={day} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: fs(12), color: "var(--color-text-secondary)", minWidth: 74 }}>{dayLabel(day, today)}</span>
        {d.slots.map(sl => renderBubble(med, day, sl))}
      </div>
    );
  };

  // Resumo do tratamento: tomadas / faltam / sem registro e o estoque
  const renderSummary = (med: Medication, phase: MedPhase | null | undefined) => {
    const st = treatmentStats(med, clock);
    const fc = stockForecast(med, clock, phase);
    const unit = med.type === "pill" ? "comprimidos" : "un.";
    const forecastText =
      fc.kind === "empty" ? "acabou"
      : fc.kind === "covers" ? "cobre o resto do tratamento"
      : `dá até ${pad2(fc.until.getDate())}/${pad2(fc.until.getMonth() + 1)}`;
    return (
      <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        <div>Tomadas {st.taken} de {st.total} · faltam {st.remaining}</div>
        {(st.unknown > 0 || st.skipped > 0) && (
          <div>
            {st.unknown > 0 && <span>⚪ {st.unknown} sem registro</span>}
            {st.unknown > 0 && st.skipped > 0 && " · "}
            {st.skipped > 0 && <span>❌ {st.skipped} não tomei</span>}
          </div>
        )}
        {(med.stock > 0 || med.lowStockAlert > 0) && <div>💊 Restam {fmtNum(med.stock)} {unit} · {forecastText}</div>}
      </div>
    );
  };

  const medToDelete = confirmDeleteId ? medications.find(m => m.id === confirmDeleteId) : null;
  const trashForProfile = trash.filter(t => t.profileId === activeProfile);
  const pendingForMe = links.filter(l => l.owner_id === user?.id && l.status === "pending");
  const sharingWithLabels = links.filter(l => l.owner_id === user?.id && l.status === "accepted").map(l => l.viewer_label || "alguém");
  const tabs: { key: "remedios" | "atendimentos" | "familia"; label: string }[] = [
    { key: "remedios", label: "💊 Remédios" },
    { key: "atendimentos", label: "🩺 Atendimentos" },
    ...(links.length > 0 ? [{ key: "familia" as const, label: `👪 Família${pendingForMe.length > 0 ? ` (${pendingForMe.length})` : ""}` }] : []),
  ];

  return (
    <div className="saude-root">
      <style>{WHEEL_CSS}</style>

      {/* Abas: Remédios | Atendimentos | tamanho do texto */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {tabs.map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              flex: "1 1 30%", minHeight: 48, borderRadius: 12, cursor: "pointer", fontSize: fs(14), fontWeight: tab === key ? 700 : 500,
              border: tab === key ? "2px solid #1A1A2E" : "1px solid var(--color-border-secondary)",
              background: tab === key ? "#1A1A2E" : "transparent",
              color: tab === key ? "#fff" : "var(--color-text-primary)",
            }}>
            {label}
          </button>
        ))}
        <button onClick={() => setShowSizePanel(v => !v)} aria-label="Tamanho do texto"
          style={{ minWidth: 48, height: 48, borderRadius: 12, border: showSizePanel ? "2px solid #1A1A2E" : "1px solid var(--color-border-secondary)", background: showSizePanel ? "rgba(26,26,46,0.06)" : "transparent", cursor: "pointer", fontSize: 16, fontWeight: 700, color: "var(--color-text-primary)" }}>
          Aa
        </button>
        <button onClick={() => setShowBackupPanel(v => !v)} aria-label="Backup da Saúde"
          style={{ minWidth: 48, height: 48, borderRadius: 12, border: showBackupPanel ? "2px solid #1A1A2E" : "1px solid var(--color-border-secondary)", background: showBackupPanel ? "rgba(26,26,46,0.06)" : "transparent", cursor: "pointer", fontSize: 18, color: "var(--color-text-primary)" }}>
          💾
        </button>
      </div>

      {showBackupPanel && <HealthBackupPanel scale={scale} />}

      {showSizePanel && (
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 14, padding: 12, marginBottom: 12 }}>
          <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 8 }}>Tamanho do texto</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${FONT_STEPS.length}, 1fr)`, gap: 6 }}>
            {FONT_STEPS.map((_, i) => (
              <button key={i} onClick={() => chooseFont(i)} aria-label={`Tamanho ${i + 1} de ${FONT_STEPS.length}`}
                style={{
                  height: 48, borderRadius: 10, cursor: "pointer", fontWeight: 700,
                  fontSize: 12 + i * 3,
                  border: fontStep === i ? "2px solid #1A1A2E" : "1px solid var(--color-border-secondary)",
                  background: fontStep === i ? "#1A1A2E" : "transparent",
                  color: fontStep === i ? "#fff" : "var(--color-text-primary)",
                }}>A</button>
            ))}
          </div>
        </div>
      )}


      {tab === "atendimentos" ? (
        <HealthVisitsView scale={scale} onCreateMedication={startFromPrescription} />
      ) : tab === "familia" ? (
        <FamilyView scale={scale} links={links} refreshLinks={refreshLinks} />
      ) : (
      <>
      {pendingForMe.length > 0 && (
        <button onClick={() => setTab("familia")}
          style={{ display: "block", width: "100%", textAlign: "left", minHeight: 52, padding: "10px 14px", borderRadius: 14, border: "1.5px solid #EF9F27", background: "rgba(239,159,39,0.12)", cursor: "pointer", marginBottom: 10, fontSize: fs(14), color: "var(--color-text-primary)" }}>
          👪 <strong>{pendingForMe[0].viewer_label || "Alguém"}</strong> pediu para acompanhar seus remédios. <u>Ver pedido</u>
        </button>
      )}
      {sharingWithLabels.length > 0 && (
        <div style={{ fontSize: fs(12), color: "#085041", background: "#E1F5EE", borderRadius: 12, padding: "8px 12px", marginBottom: 10 }}>
          🔗 Compartilhando com {sharingWithLabels.join(", ")}
        </div>
      )}

      {/* Perfis de família */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, gap: 8 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {profiles.map(p => (
            <button key={p.id} onClick={() => setActiveProfile(p.id)}
              title={p.name} aria-label={p.name}
              style={{
                width: 44, height: 44, borderRadius: "50%", border: activeProfile === p.id ? "2px solid #1A1A2E" : "1.5px solid #E0E0E0",
                background: activeProfile === p.id ? "rgba(26,26,46,0.05)" : "transparent",
                fontSize: 22, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}>{p.icon}</button>
          ))}
          {profiles.length < 5 && (
            <button onClick={() => setShowAddProfile(true)} aria-label="Adicionar perfil"
              style={{ width: 44, height: 44, borderRadius: "50%", border: "1.5px dashed #BDBDBD", background: "transparent", fontSize: 20, cursor: "pointer", color: "#BDBDBD" }}>+</button>
          )}
        </div>
        <span style={{ fontSize: fs(13), color: "var(--color-text-secondary)", fontWeight: 500 }}>{profiles.find(p => p.id === activeProfile)?.name}</span>
      </div>

      {/* Resumo */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[
          { label: "Ativos", value: profileMeds.length, bg: "var(--color-background-secondary)", color: "var(--color-text-primary)" },
          { label: "Hoje", value: todayPlanned > 0 ? `${todayTaken}/${todayPlanned}` : "—", bg: "#E1F5EE", color: "#085041" },
          { label: "Próximos", value: upcoming, bg: "#FAEEDA", color: "#633806" },
        ].map(s => (
          <div key={s.label} style={{ background: s.bg, borderRadius: 12, padding: "10px 8px", textAlign: "center" }}>
            <div style={{ fontSize: fs(22), fontWeight: 600, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: fs(11), color: s.color, opacity: 0.85 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Cartões */}
      {profileMeds.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "var(--color-text-secondary)" }}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>💊</div>
          <div style={{ fontSize: fs(15), fontWeight: 600 }}>Nenhum medicamento cadastrado</div>
          <div style={{ fontSize: fs(13), marginTop: 4 }}>Toque em “Adicionar medicamento” abaixo</div>
        </div>
      ) : (
        profileMeds.map(med => {
          const phaseIdx = getCurrentPhaseIndex(med.phases, med.startDate);
          const phase = med.phases[phaseIdx];
          const totalDays = getTotalDays(med.phases);
          const elapsed = Math.min(getDaysElapsed(med.startDate), totalDays);
          const progress = Math.min(100, Math.round((elapsed / Math.max(1, totalDays)) * 100));
          const nextTime = getNextSchedule(med.phases, phaseIdx);
          const perDay = Math.max(1, phase?.timesPerDay ?? 1);
          const log = ensureLog(med);
          const freeToday = freeSlotsFor(log, today, perDay);
          const takenToday = log.filter(e => e.day === today && e.kind === "taken").length;
          const allDone = freeToday.length === 0;
          const yesterdayDate = parseDay(today);
          yesterdayDate.setDate(yesterdayDate.getDate() - 1);
          const yesterdayKey = localKey(yesterdayDate);
          const dayNo = Math.min(Math.max(getDaysElapsed(med.startDate) + 1, 0), totalDays);
          const hasLiveToday = log.some(e => e.kind === "taken" && !e.late && keyOfIso(e.at) === today);
          const lowStock = med.lowStockAlert > 0 && med.stock <= med.lowStockAlert;
          const dose = getDoseStatus(getPhaseOnDate(med, clock), med.takenDates, clock, freeToday);

          return (
            <div key={med.id} style={{
              background: "var(--color-background-primary)",
              border: `0.5px solid ${lowStock ? "#FAC775" : "var(--color-border-tertiary)"}`,
              borderRadius: 18, padding: 14, marginBottom: 12,
            }}>
              {/* Linha 1: ícone (editar) · nome e dose · lixeira (direita) */}
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <button onClick={() => openEdit(med)} aria-label={`Editar ${med.name}`}
                  style={{ position: "relative", width: 58, height: 58, borderRadius: "50%", background: `${med.color}20`, border: `2px solid ${med.color}55`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: fs(26), lineHeight: 1, flexShrink: 0, padding: 0 }}>
                  {TYPE_MAP[med.type].icon}
                  <span style={{ position: "absolute", right: -3, bottom: -3, width: 22, height: 22, borderRadius: "50%", background: "#1A1A2E", display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid var(--color-background-primary)" }}>
                    <Pencil size={11} color="#fff" />
                  </span>
                </button>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: fs(16), fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>
                    <span
                      className={dose.kind === "soon" ? "med-hl-soon" : dose.kind === "late" ? "med-hl-late" : dose.kind === "recent" ? "med-hl-ok" : undefined}
                      style={{
                        display: "inline-block", padding: "2px 10px", marginLeft: -12, borderRadius: 14, border: "2px solid transparent",
                        ...(dose.kind === "soon" ? { borderColor: "#EF9F27", background: "rgba(239,159,39,0.16)" } : {}),
                        ...(dose.kind === "late" ? { borderColor: "#E24B4A", background: "rgba(226,75,74,0.14)" } : {}),
                        ...(dose.kind === "recent" ? { borderColor: "#1D9E75", background: "rgba(29,158,117,0.14)" } : {}),
                      }}
                    >
                      {med.name}
                    </span>
                  </div>
                  {dose.kind === "soon" && <div style={{ fontSize: fs(12), fontWeight: 600, color: "#B26B00", marginTop: 2 }}>⏰ Falta {fmtMinutes(dose.minutes)} para a dose</div>}
                  {dose.kind === "late" && <div style={{ fontSize: fs(12), fontWeight: 600, color: "#C62828", marginTop: 2 }}>⚠️ Dose atrasada há {fmtMinutes(dose.minutes)}</div>}
                  <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginTop: 2 }}>
                    {phase ? `${fmtDose(phase.dose)} ${unitLabel(phase.doseUnit, phase.dose)} · ${phase.timesPerDay}x ao dia` : ""}
                  </div>
                  <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginTop: 1 }}>
                    Próximo: <strong style={{ color: "var(--color-text-primary)" }}>{nextTime}</strong>
                    {lowStock && <span style={{ marginLeft: 8, fontSize: fs(11), padding: "2px 7px", borderRadius: 20, background: "#FAEEDA", color: "#633806", fontWeight: 600 }}>⚠️ Estoque: {med.stock}</span>}
                  </div>
                  {med.origin && <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginTop: 2, wordBreak: "break-word" }}>📋 {med.origin.label}</div>}
                </div>

                <button onClick={() => setConfirmDeleteId(med.id)} aria-label={`Mover ${med.name} para a lixeira`}
                  style={{ width: 46, height: 46, borderRadius: 14, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Trash2 size={20} color="#E24B4A" />
                </button>
              </div>

              {/* Linha 2: status Tomado / botão Tomei — centralizado */}
              <div style={{ marginTop: 14 }}>
                {allDone ? (
                  <div style={{ textAlign: "center", padding: "14px 10px", borderRadius: 14, background: "#E1F5EE", border: "2px solid #1D9E75", color: "#085041", fontSize: fs(17), fontWeight: 700 }}>
                    {takenToday >= perDay ? "✅ TOMADO" : `Doses de hoje: ${takenToday} de ${perDay}`}
                  </div>
                ) : (
                  <button onClick={() => takeMed(med.id)}
                    style={{ width: "100%", minHeight: 56, borderRadius: 14, border: "none", background: med.color, color: "white", fontSize: fs(17), fontWeight: 700, cursor: "pointer" }}>
                    ✓ TOMEI{perDay > 1 ? ` · dose ${perDay - freeToday.length + 1} de ${perDay}` : ""}
                  </button>
                )}
                {hasLiveToday && (
                  <div style={{ textAlign: "center", marginTop: 6 }}>
                    <button onClick={() => undoLastDose(med.id)}
                      style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: fs(12), color: "var(--color-text-secondary)", textDecoration: "underline", padding: "8px 12px", minHeight: 36 }}>
                      Desfazer última dose
                    </button>
                  </div>
                )}
              </div>

              {/* Linha 3: fases, progresso e histórico */}
              <div style={{ display: "flex", gap: 2, margin: "12px 0 8px", borderRadius: 4, overflow: "hidden", height: 6 }}>
                {med.phases.map((p, i) => (
                  <div key={i} style={{ flex: p.days, background: COLORS[i % COLORS.length], opacity: i <= phaseIdx ? 1 : 0.3 }} />
                ))}
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ height: 5, width: "100%", maxWidth: 160, borderRadius: 3, background: "var(--color-border-tertiary)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${progress}%`, background: med.color, borderRadius: 3 }} />
                  </div>
                  <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginTop: 3 }}>{getDaysElapsed(med.startDate) < 0 ? `Começa em ${-getDaysElapsed(med.startDate)} ${-getDaysElapsed(med.startDate) === 1 ? "dia" : "dias"}` : `Dia ${dayNo} de ${totalDays}`}</div>
                </div>
                <button onClick={() => setShowHistory(med.id)} aria-label="Ver histórico"
                  style={{ width: 46, height: 46, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: 20 }}>
                  📅
                </button>
              </div>

              {/* Doses: hoje e ontem (toque numa bolinha para marcar ou corrigir) */}
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                {renderDayRow(med, today, phase)}
                {renderDayRow(med, yesterdayKey, null)}
                {renderSummary(med, phase)}
              </div>
            </div>
          );
        })
      )}

      {/* Botão adicionar */}
      <button onClick={openNew}
        style={{ width: "100%", padding: 14, minHeight: 54, borderRadius: 14, border: "1.5px dashed var(--color-border-secondary)", background: "transparent", color: "var(--color-text-secondary)", fontSize: fs(14), fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 4 }}>
        <Plus size={18} /> Adicionar medicamento
      </button>

      {trashForProfile.length > 0 && (
        <button onClick={() => setShowTrash(true)}
          style={{ width: "100%", minHeight: 48, borderRadius: 14, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", color: "#E24B4A", fontSize: fs(14), fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 10 }}>
          <Trash2 size={17} /> Lixeira ({trashForProfile.length})
        </button>
      )}

      {showTrash && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
          onClick={() => setShowTrash(false)}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: "20px 20px 0 0", padding: 20, width: "100%", maxWidth: 480, maxHeight: "80vh", overflowY: "auto" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: fs(16), fontWeight: 600, color: "var(--color-text-primary)" }}>🗑️ Lixeira</div>
              <button onClick={() => setShowTrash(false)} aria-label="Fechar" style={{ background: "transparent", border: "none", cursor: "pointer", width: 44, height: 44 }}><X size={20} /></button>
            </div>
            <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginBottom: 14 }}>
              Os medicamentos na lixeira são apagados definitivamente após {TRASH_DAYS} dias. Enquanto estiverem aqui, não tocam alarme.
            </div>
            {trashForProfile.length === 0 ? (
              <div style={{ textAlign: "center", padding: 24, color: "var(--color-text-secondary)", fontSize: fs(14) }}>Lixeira vazia</div>
            ) : (
              trashForProfile.map(t => (
                <div key={t.id} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: 14, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{ fontSize: fs(22) }}>{TYPE_MAP[t.type].icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: fs(15), fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{t.name}</div>
                      <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)" }}>Removido em {fmtDateTime(t.deletedAt)}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => restoreFromTrash(t.id)}
                      style={{ flex: 1, minHeight: 46, borderRadius: 12, border: "none", background: "#1D9E75", color: "white", fontSize: fs(14), fontWeight: 700, cursor: "pointer" }}>Restaurar</button>
                    <button onClick={() => setConfirmPurgeId(t.id)}
                      style={{ flex: 1, minHeight: 46, borderRadius: 12, border: "1px solid #F7C1C1", background: "transparent", color: "#E24B4A", fontSize: fs(14), fontWeight: 600, cursor: "pointer" }}>Excluir de vez</button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {confirmPurgeId && (
        <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setConfirmPurgeId(null)}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 20, padding: 22, width: "88%", maxWidth: 340 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: fs(16), fontWeight: 600, marginBottom: 8, textAlign: "center", color: "var(--color-text-primary)" }}>Excluir de vez?</div>
            <div style={{ fontSize: fs(14), color: "var(--color-text-secondary)", textAlign: "center", marginBottom: 18 }}>Isso apaga o medicamento e todo o histórico de doses. Não dá para desfazer.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmPurgeId(null)} style={{ flex: 1, padding: 12, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(14), color: "var(--color-text-primary)" }}>Cancelar</button>
              <button onClick={() => purgeFromTrash(confirmPurgeId)} style={{ flex: 1, padding: 12, minHeight: 48, borderRadius: 12, border: "none", background: "#E24B4A", color: "white", cursor: "pointer", fontWeight: 600, fontSize: fs(14) }}>Excluir de vez</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal histórico: dia a dia, com os horários */}
      {showHistory && (() => {
        const med = medications.find(m => m.id === showHistory);
        if (!med) return null;
        const phaseNow = med.phases[getCurrentPhaseIndex(med.phases, med.startDate)];
        const start = parseDay(med.startDate);
        const days: string[] = [];
        for (let i = 0; i < 90; i++) {
          const d = parseDay(today);
          d.setDate(d.getDate() - i);
          if (d.getTime() < start.getTime()) break;
          days.push(localKey(d));
        }
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={() => setShowHistory(null)}>
            <div style={{ background: "var(--color-background-primary)", borderRadius: "20px 20px 0 0", padding: 20, width: "100%", maxWidth: 480, maxHeight: "85vh", overflowY: "auto" }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: fs(16), fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>Histórico — {med.name}</div>
                <button onClick={() => setShowHistory(null)} aria-label="Fechar" style={{ background: "transparent", border: "none", cursor: "pointer", width: 44, height: 44 }}><X size={20} /></button>
              </div>
              <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginBottom: 12 }}>
                Toque num horário para marcar que tomou, que não tomou, ou corrigir a hora. ⚪ sem registro quer dizer que não há marcação (não que a dose não foi tomada).
              </div>
              <div style={{ marginBottom: 12 }}>
                {days.map(d => renderDayRow(med, d, d === today ? phaseNow : null))}
              </div>
              <div style={{ borderTop: "0.5px solid var(--color-border-tertiary)", paddingTop: 10 }}>
                {renderSummary(med, phaseNow)}
                <div style={{ fontSize: fs(11), color: "var(--color-text-secondary)", marginTop: 8 }}>
                  Para lançar doses de dias antes do cadastro, edite o remédio e coloque a data de início certa.
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Janelinha de uma dose */}
      {slotSheet && (() => {
        const med = medications.find(m => m.id === slotSheet.medId);
        if (!med) return null;
        const fallback = med.phases[getCurrentPhaseIndex(med.phases, med.startDate)];
        const sl = buildDay(med, slotSheet.day, clock, fallback).slots.find(x => x.slot === slotSheet.slot);
        if (!sl) return null;
        const e = sl.entry;
        const status = e?.kind === "taken"
          ? `✅ Tomado às ${fmtHM(e.at)} · ${e.late ? "informado depois" : "marcado na hora"}`
          : e?.kind === "skipped" ? "❌ Marcado como não tomado" : "⚪ Sem registro";
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}
            onClick={() => setSlotSheet(null)}>
            <div style={{ background: "var(--color-background-primary)", borderRadius: "20px 20px 0 0", padding: 20, width: "100%", maxWidth: 480 }}
              onClick={ev => ev.stopPropagation()}>
              <div style={{ fontSize: fs(16), fontWeight: 600, color: "var(--color-text-primary)", wordBreak: "break-word" }}>{med.name}</div>
              <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 10 }}>Dose das {sl.label} · {dayLabel(slotSheet.day, today)}</div>
              <div style={{ fontSize: fs(14), fontWeight: 600, color: "var(--color-text-primary)", marginBottom: 12 }}>{status}</div>

              {e?.kind !== "skipped" && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 }}>Hora em que tomou</div>
                  <input type="time" value={slotTime} onChange={ev => ev.target.value && setSlotTime(ev.target.value)}
                    style={{ width: "100%", padding: "11px 12px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", fontSize: fs(22), fontWeight: 700, textAlign: "center", background: "transparent", color: "var(--color-text-primary)" }} />
                </div>
              )}

              <button onClick={() => applySlot("taken")}
                style={{ width: "100%", minHeight: 52, borderRadius: 14, border: "none", background: "#1D9E75", color: "#fff", fontSize: fs(15), fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>
                {e?.kind === "taken" ? "✅ Salvar a hora" : "✅ Tomei"}
              </button>
              {e?.kind !== "skipped" && (
                <button onClick={() => applySlot("skipped")}
                  style={{ width: "100%", minHeight: 48, borderRadius: 14, border: "1px solid #F7C1C1", background: "rgba(252,235,235,0.5)", color: "#E24B4A", fontSize: fs(14), fontWeight: 700, cursor: "pointer", marginBottom: 8 }}>
                  ❌ Não tomei
                </button>
              )}
              <button onClick={() => (e ? applySlot("clear") : setSlotSheet(null))}
                style={{ width: "100%", minHeight: 48, borderRadius: 14, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: fs(14), cursor: "pointer", marginBottom: 8 }}>
                {e ? "Voltar para sem registro" : "Deixar sem registro"}
              </button>
              <button onClick={() => setSlotSheet(null)}
                style={{ width: "100%", minHeight: 44, borderRadius: 14, border: "none", background: "transparent", color: "var(--color-text-secondary)", fontSize: fs(13), cursor: "pointer" }}>
                Cancelar
              </button>
              {e?.kind === "taken" && (
                <div style={{ fontSize: fs(11), color: "var(--color-text-secondary)", textAlign: "center", marginTop: 4 }}>"Voltar para sem registro" devolve o comprimido ao estoque.</div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Confirmação de exclusão */}
      {medToDelete && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setConfirmDeleteId(null)}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 20, padding: 22, width: "88%", maxWidth: 340 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: fs(16), fontWeight: 600, marginBottom: 8, textAlign: "center", color: "var(--color-text-primary)" }}>Mover para a lixeira?</div>
            <div style={{ fontSize: fs(14), color: "var(--color-text-secondary)", textAlign: "center", marginBottom: 18, wordBreak: "break-word" }}>
              {medToDelete.name} sai da lista e os alarmes dele param. Você pode restaurar em até 30 dias, na lixeira.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setConfirmDeleteId(null)} style={{ flex: 1, padding: 12, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(14), color: "var(--color-text-primary)" }}>Cancelar</button>
              <button onClick={() => moveToTrash(medToDelete.id)} style={{ flex: 1, padding: 12, minHeight: 48, borderRadius: 12, border: "none", background: "#E24B4A", color: "white", cursor: "pointer", fontWeight: 600, fontSize: fs(14) }}>Mover para a lixeira</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal adicionar perfil */}
      {showAddProfile && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "var(--color-background-primary)", borderRadius: 20, padding: 24, width: "88%", maxWidth: 340 }}>
            <div style={{ fontSize: fs(16), fontWeight: 600, marginBottom: 14, textAlign: "center" }}>Novo perfil</div>
            <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="Nome do familiar"
              style={{ ...inputStyle, marginBottom: 12 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 16, flexWrap: "wrap" }}>
              {PROFILE_ICONS.map(icon => (
                <button key={icon} onClick={() => setNewProfileIcon(icon)}
                  style={{ width: 44, height: 44, borderRadius: "50%", border: newProfileIcon === icon ? "2px solid #1A1A2E" : "1px solid #E0E0E0", background: "transparent", fontSize: 22, cursor: "pointer" }}>
                  {icon}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowAddProfile(false)} style={{ flex: 1, padding: 12, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", cursor: "pointer", fontSize: fs(14), color: "var(--color-text-primary)" }}>Cancelar</button>
              <button onClick={addProfile} style={{ flex: 1, padding: 12, minHeight: 48, borderRadius: 12, border: "none", background: "#1A1A2E", color: "white", cursor: "pointer", fontWeight: 600, fontSize: fs(14) }}>Criar</button>
            </div>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
