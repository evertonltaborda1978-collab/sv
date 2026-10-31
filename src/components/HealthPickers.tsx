import { useEffect, useRef, useState } from "react";
import { ChevronDown, Pencil, Trash2 } from "lucide-react";
import { DirDoctor, DirPlace, HealthDirectory, PLACE_TYPES } from "@/lib/healthVisits";

// Menus suspensos de "Onde foi atendido" e "Médico(a)" (com CRM).
// Os locais e médicos cadastrados ficam numa lista própria (aparelho + nuvem),
// e cada atendimento guarda o que foi escolhido nele: dá para trocar o local
// de um atendimento para outro sem mexer no médico.

const ACCENT = "#1A1A2E";
const RED = "#E24B4A";

type Fs = (n: number) => number;
type AskConfirm = (text: string, yes: () => void) => void;

function useFechaAoTocarFora(ref: React.RefObject<HTMLElement>, ativo: boolean, fechar: () => void) {
  const fecharRef = useRef(fechar);
  fecharRef.current = fechar;
  useEffect(() => {
    if (!ativo) return;
    const h = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fecharRef.current();
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, [ativo, ref]);
}

const semAcento = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export const rotuloCrm = (crm: string) => {
  const c = crm.trim();
  if (!c) return "";
  return /^crm/i.test(c) ? c : `CRM ${c}`;
};

const painel = (): React.CSSProperties => ({
  position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 40, maxHeight: 340, overflowY: "auto",
  background: "var(--color-background-primary)", border: "1px solid var(--color-border-secondary)", borderRadius: 14,
  boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
});

const botaoCampo = (fs: Fs): React.CSSProperties => ({
  width: "100%", minHeight: 48, padding: "10px 12px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)",
  background: "transparent", color: "var(--color-text-primary)", fontSize: fs(15), cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, textAlign: "left",
});

const iconeBtn: React.CSSProperties = {
  width: 40, height: 44, flexShrink: 0, background: "transparent", border: "none", cursor: "pointer",
  display: "flex", alignItems: "center", justifyContent: "center", color: "var(--color-text-secondary)",
};

const linhaBorda = "0.5px solid var(--color-border-tertiary)";

function chip(ativo: boolean, fs: Fs): React.CSSProperties {
  return {
    padding: "9px 12px", minHeight: 40, borderRadius: 20, cursor: "pointer", fontSize: fs(13),
    border: `1.5px solid ${ativo ? ACCENT : "var(--color-border-secondary)"}`,
    background: ativo ? ACCENT : "transparent", color: ativo ? "#fff" : "var(--color-text-primary)", fontWeight: ativo ? 600 : 400,
  };
}

function campoTexto(fs: Fs): React.CSSProperties {
  return {
    width: "100%", padding: "11px 12px", borderRadius: 12, border: "0.5px solid var(--color-border-secondary)",
    fontSize: fs(15), background: "transparent", color: "var(--color-text-primary)",
  };
}

// ── Onde foi atendido ──
export function LocalField({
  type, name, dir, onPick, onDirChange, askConfirm, fs,
}: {
  type: string;
  name: string;
  dir: HealthDirectory;
  onPick: (type: string, name: string) => void;
  onDirChange: (d: HealthDirectory) => void;
  askConfirm: AskConfirm;
  fs: Fs;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<{ id?: string; type: string; name: string } | null>(null);
  useFechaAoTocarFora(wrap, aberto, () => { setAberto(false); setForm(null); });

  const locais = [...dir.places].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  const texto = name && type ? `${type} · ${name}` : name || type || "";

  const salvarForm = () => {
    if (!form || !form.name.trim()) return;
    const nome = form.name.trim();
    const proximos: DirPlace[] = form.id
      ? dir.places.map((p) => (p.id === form.id ? { ...p, type: form.type, name: nome } : p))
      : [...dir.places, { id: crypto.randomUUID(), type: form.type, name: nome }];
    onDirChange({ ...dir, places: proximos });
    onPick(form.type, nome);
    setForm(null);
    setAberto(false);
  };

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button type="button" onClick={() => { setAberto((a) => !a); setForm(null); }} style={botaoCampo(fs)} aria-expanded={aberto}>
        <span style={{ color: texto ? "var(--color-text-primary)" : "var(--color-text-secondary)", wordBreak: "break-word" }}>{texto || "Escolher o local"}</span>
        <ChevronDown size={18} />
      </button>

      {aberto && (
        <div style={painel()}>
          {!form && (
            <>
              {locais.length === 0 && (
                <div style={{ padding: 14, fontSize: fs(13), color: "var(--color-text-secondary)" }}>Nenhum local salvo ainda.</div>
              )}
              {locais.map((p) => {
                const atual = p.name === name && p.type === type;
                return (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", borderBottom: linhaBorda, background: atual ? "var(--color-background-secondary)" : "transparent" }}>
                    <button type="button" onClick={() => { onPick(p.type, p.name); setAberto(false); }}
                      style={{ flex: 1, minWidth: 0, textAlign: "left", padding: "10px 12px", minHeight: 48, background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-primary)" }}>
                      <div style={{ fontSize: fs(14), fontWeight: 600, wordBreak: "break-word" }}>{p.name}</div>
                      {p.type && <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)" }}>{p.type}</div>}
                    </button>
                    <button type="button" aria-label={`Editar ${p.name}`} onClick={() => setForm({ id: p.id, type: p.type, name: p.name })} style={iconeBtn}><Pencil size={16} /></button>
                    <button type="button" aria-label={`Excluir ${p.name}`}
                      onClick={() => askConfirm(`Excluir "${p.name}" da lista de locais? Os atendimentos que já usam esse local não mudam.`, () => onDirChange({ ...dir, places: dir.places.filter((x) => x.id !== p.id) }))}
                      style={iconeBtn}><Trash2 size={16} color={RED} /></button>
                  </div>
                );
              })}
              <button type="button" onClick={() => setForm({ type: "", name: "" })}
                style={{ width: "100%", minHeight: 52, background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-primary)", fontSize: fs(14), fontWeight: 600 }}>
                + Cadastrar novo local
              </button>
            </>
          )}

          {form && (
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 }}>Tipo</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                {PLACE_TYPES.map((t) => (
                  <button key={t} type="button" onClick={() => setForm({ ...form, type: form.type === t ? "" : t })} style={chip(form.type === t, fs)}>{t}</button>
                ))}
              </div>
              <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 }}>Nome do local</div>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: UPA Central" style={{ ...campoTexto(fs), marginBottom: 12 }} autoFocus />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={salvarForm} disabled={!form.name.trim()}
                  style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "none", background: "#2D9E7F", color: "#fff", fontSize: fs(14), fontWeight: 700, cursor: "pointer", opacity: form.name.trim() ? 1 : 0.5 }}>
                  Salvar e usar
                </button>
                <button type="button" onClick={() => setForm(null)}
                  style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: fs(14), cursor: "pointer" }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Médico(a) + CRM ──
export function MedicoField({
  name, crm, dir, onPick, onCrmChange, onDirChange, askConfirm, fs,
}: {
  name: string;
  crm: string;
  dir: HealthDirectory;
  onPick: (name: string, crm: string) => void;
  onCrmChange: (crm: string) => void;
  onDirChange: (d: HealthDirectory) => void;
  askConfirm: AskConfirm;
  fs: Fs;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [form, setForm] = useState<{ id?: string; name: string; crm: string } | null>(null);
  useFechaAoTocarFora(wrap, aberto, () => { setAberto(false); setForm(null); });

  const q = semAcento(busca);
  const medicos = [...dir.doctors]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .filter((d) => !q || semAcento(d.name).includes(q) || semAcento(d.crm).includes(q));

  const salvarForm = () => {
    if (!form || !form.name.trim()) return;
    const nome = form.name.trim();
    const crmTxt = form.crm.trim();
    const proximos: DirDoctor[] = form.id
      ? dir.doctors.map((d) => (d.id === form.id ? { ...d, name: nome, crm: crmTxt } : d))
      : [...dir.doctors, { id: crypto.randomUUID(), name: nome, crm: crmTxt }];
    onDirChange({ ...dir, doctors: proximos });
    onPick(nome, crmTxt);
    setForm(null);
    setBusca("");
    setAberto(false);
  };

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => { setAberto((a) => !a); setForm(null); setBusca(""); }} style={{ ...botaoCampo(fs), flex: 1, minWidth: 0, width: "auto" }} aria-expanded={aberto}>
          <span style={{ color: name ? "var(--color-text-primary)" : "var(--color-text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name || "Escolher o médico(a)"}</span>
          <ChevronDown size={18} style={{ flexShrink: 0 }} />
        </button>
        <input
          value={crm}
          onChange={(e) => onCrmChange(e.target.value)}
          placeholder="CRM"
          aria-label="CRM do médico"
          style={{ ...campoTexto(fs), width: 124, minHeight: 48, textAlign: "center", flexShrink: 0, padding: "10px 8px" }}
        />
      </div>

      {aberto && (
        <div style={painel()}>
          {!form && (
            <>
              <div style={{ padding: 10, borderBottom: linhaBorda }}>
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome ou CRM" style={campoTexto(fs)} autoFocus />
              </div>
              {medicos.length === 0 && (
                <div style={{ padding: 14, fontSize: fs(13), color: "var(--color-text-secondary)" }}>
                  {dir.doctors.length === 0 ? "Nenhum médico salvo ainda." : "Nenhum médico encontrado."}
                </div>
              )}
              {medicos.map((d) => {
                const atual = d.name === name;
                return (
                  <div key={d.id} style={{ display: "flex", alignItems: "center", borderBottom: linhaBorda, background: atual ? "var(--color-background-secondary)" : "transparent" }}>
                    <button type="button" onClick={() => { onPick(d.name, d.crm); setAberto(false); setBusca(""); }}
                      style={{ flex: 1, minWidth: 0, textAlign: "left", padding: "10px 12px", minHeight: 48, background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-primary)" }}>
                      <div style={{ fontSize: fs(14), fontWeight: 600, wordBreak: "break-word" }}>{d.name}</div>
                      <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)" }}>{d.crm ? rotuloCrm(d.crm) : "sem CRM"}</div>
                    </button>
                    <button type="button" aria-label={`Editar ${d.name}`} onClick={() => setForm({ id: d.id, name: d.name, crm: d.crm })} style={iconeBtn}><Pencil size={16} /></button>
                    <button type="button" aria-label={`Excluir ${d.name}`}
                      onClick={() => askConfirm(`Excluir "${d.name}" da lista de médicos? Os atendimentos que já usam esse médico não mudam.`, () => onDirChange({ ...dir, doctors: dir.doctors.filter((x) => x.id !== d.id) }))}
                      style={iconeBtn}><Trash2 size={16} color={RED} /></button>
                  </div>
                );
              })}
              <button type="button" onClick={() => setForm({ name: busca.trim(), crm: "" })}
                style={{ width: "100%", minHeight: 52, background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-primary)", fontSize: fs(14), fontWeight: 600 }}>
                {busca.trim() && medicos.length === 0 ? `+ Cadastrar "${busca.trim()}"` : "+ Cadastrar médico (nome e CRM, se tiver)"}
              </button>
            </>
          )}

          {form && (
            <div style={{ padding: 12 }}>
              <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 }}>Nome do médico(a)</div>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Dra. Ana Souza" style={{ ...campoTexto(fs), marginBottom: 12 }} autoFocus />
              <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 6 }}>CRM (se tiver)</div>
              <input value={form.crm} onChange={(e) => setForm({ ...form, crm: e.target.value })} placeholder="Ex.: 12345/PR" style={{ ...campoTexto(fs), marginBottom: 12 }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={salvarForm} disabled={!form.name.trim()}
                  style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "none", background: "#2D9E7F", color: "#fff", fontSize: fs(14), fontWeight: 700, cursor: "pointer", opacity: form.name.trim() ? 1 : 0.5 }}>
                  Salvar e usar
                </button>
                <button type="button" onClick={() => setForm(null)}
                  style={{ flex: 1, minHeight: 48, borderRadius: 12, border: "0.5px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)", fontSize: fs(14), cursor: "pointer" }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
