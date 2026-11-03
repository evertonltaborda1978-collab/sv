import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLicense } from "@/hooks/useLicense";
import {
  APP_NAME,
  APP_URL,
  MODULE_LABELS,
  adminGenerateKey,
  adminList,
  adminSetStatus,
  type LicenseRow,
  type Modules,
} from "@/lib/license";

const ALERT_FLAG = "sv_admin_alert_shown";

const STATUS_STYLE: Record<LicenseRow["status"], { label: string; cls: string }> = {
  active: { label: "Ativo", cls: "bg-green-500/15 text-green-700 dark:text-green-400" },
  pending: { label: "Pendente", cls: "bg-yellow-500/20 text-yellow-700 dark:text-yellow-300" },
  blocked: { label: "Bloqueado", cls: "bg-red-500/15 text-red-700 dark:text-red-400" },
  on_hold: { label: "Em espera", cls: "bg-slate-500/20 text-slate-700 dark:text-slate-300" },
};

const fmt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
    : "Nunca";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function AdminPanel({ onClose }: { onClose: () => void }) {
  const { loading: licLoading, isAdmin } = useLicense();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const [rows, setRows] = useState<LicenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAlert, setShowAlert] = useState(false);

  // modal de chave
  const [target, setTarget] = useState<LicenseRow | null>(null);
  const [mods, setMods] = useState<Modules>({ saude: false, seguranca: false, agenda: false });
  const [generated, setGenerated] = useState("");
  const [copied, setCopied] = useState(false);
  const [genBusy, setGenBusy] = useState(false);

  const awaiting = useMemo(
    () => rows.filter((r) => r.status === "pending" && !r.key_generated_at),
    [rows],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await adminList();
      setRows(data);
      const waiting = data.filter((r) => r.status === "pending" && !r.key_generated_at).length;
      if (waiting > 0 && !sessionStorage.getItem(ALERT_FLAG)) {
        sessionStorage.setItem(ALERT_FLAG, "1");
        setShowAlert(true);
      }
    } catch (e: any) {
      setError(e?.message ?? "Não foi possível carregar os clientes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (licLoading) return;
    if (!isAdmin) {
      closeRef.current();
      return;
    }
    load();
  }, [licLoading, isAdmin, load]);

  const openKeyModal = (r: LicenseRow) => {
    setTarget(r);
    setMods({ ...r.modules });
    setGenerated("");
    setCopied(false);
  };

  const closeKeyModal = () => {
    setTarget(null);
    setGenerated("");
    load();
  };

  const generate = async () => {
    if (!target) return;
    setGenBusy(true);
    setError("");
    try {
      setGenerated(await adminGenerateKey(target.id, mods));
    } catch (e: any) {
      setError(e?.message ?? "Erro ao gerar a chave.");
    } finally {
      setGenBusy(false);
    }
  };

  const mailtoHref = () => {
    if (!target || !generated) return "#";
    const subject = `Sua chave de ativação do ${APP_NAME}`;
    const body =
      `Olá, ${target.name.split(" ")[0]}!\n\n` +
      `Seu acesso ao ${APP_NAME} foi liberado.\n\n` +
      `Chave de ativação: ${generated}\n\n` +
      `Como ativar:\n` +
      `1. Abra ${APP_URL}\n` +
      `2. Toque em "Ativar"\n` +
      `3. Digite seu e-mail (${target.email}) e a chave acima\n` +
      `4. Crie sua senha definitiva\n\n` +
      `A chave só funciona uma vez.`;
    return `mailto:${encodeURIComponent(target.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  const changeStatus = async (r: LicenseRow, action: "block" | "unblock" | "hold") => {
    setBusyId(r.id);
    setError("");
    try {
      await adminSetStatus(r.id, action);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Erro ao atualizar.");
    } finally {
      setBusyId(null);
    }
  };

  if (licLoading || (!isAdmin && !error)) {
    return <div className="p-6 text-center text-muted-foreground">Carregando...</div>;
  }

  const btn = "rounded-md border border-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50";

  return (
    <div
      className="min-h-screen bg-background text-foreground"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold">Painel — {APP_NAME}</h1>
          <p className="text-xs text-muted-foreground">{rows.length} cliente(s)</p>
        </div>
        <div className="flex gap-2">
          <button className={btn} onClick={load} disabled={loading}>
            {loading ? "Atualizando..." : "Atualizar"}
          </button>
          <button className={btn} onClick={onClose}>Fechar</button>
        </div>
      </header>

      {error && (
        <p role="alert" className="m-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="overflow-x-auto p-4">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-2 py-2 font-medium">Cliente</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Módulos</th>
              <th className="px-2 py-2 font-medium">Dispositivos</th>
              <th className="px-2 py-2 font-medium">Último acesso</th>
              <th className="px-2 py-2 font-medium">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = STATUS_STYLE[r.status];
              const keySent = !!r.key_generated_at && !r.key_used_at;
              const hasKey = !!r.key_generated_at;
              const isBusy = busyId === r.id;
              return (
                <tr key={r.id} className="border-b border-border align-top">
                  <td className="px-2 py-3">
                    <div className="font-medium">{r.name}</div>
                    <div className="break-all text-xs text-muted-foreground">{r.email}</div>
                    <div className="text-xs text-muted-foreground">Pedido em {fmt(r.created_at)}</div>
                  </td>
                  <td className="px-2 py-3">
                    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${st.cls}`}>
                      {st.label}
                    </span>
                    {r.status === "pending" && keySent && (
                      <div className="mt-1 text-xs text-muted-foreground">chave enviada</div>
                    )}
                  </td>
                  <td className="px-2 py-3 text-xs">
                    {(Object.keys(MODULE_LABELS) as (keyof Modules)[])
                      .filter((m) => r.modules[m])
                      .map((m) => MODULE_LABELS[m])
                      .join(", ") || "—"}
                  </td>
                  <td className="px-2 py-3 text-center">{r.device_count}</td>
                  <td className="px-2 py-3 text-xs">{fmt(r.last_access)}</td>
                  <td className="px-2 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {r.status !== "blocked" && (
                        <button className={btn} disabled={isBusy} onClick={() => openKeyModal(r)}>
                          {hasKey ? "Regenerar chave" : "Gerar chave"}
                        </button>
                      )}
                      {r.status === "blocked" ? (
                        <button className={btn} disabled={isBusy} onClick={() => changeStatus(r, "unblock")}>
                          Desbloquear
                        </button>
                      ) : (
                        <button
                          className={`${btn} text-red-600 dark:text-red-400`}
                          disabled={isBusy}
                          onClick={() => changeStatus(r, "block")}
                        >
                          Bloquear
                        </button>
                      )}
                      {r.status === "pending" && (
                        <button className={btn} disabled={isBusy} onClick={() => changeStatus(r, "hold")}>
                          Deixar em espera
                        </button>
                      )}
                      {r.status === "on_hold" && (
                        <button className={btn} disabled={isBusy} onClick={() => changeStatus(r, "unblock")}>
                          Tirar da espera
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-8 text-center text-muted-foreground">
                  Nenhum cliente ainda.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Alerta único ao entrar */}
      {showAlert && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-background p-5 shadow-xl">
            <h2 className="text-lg font-semibold">Novos pedidos de licença</h2>
            <p className="text-sm">
              {awaiting.length === 1
                ? "1 usuário está aguardando liberação:"
                : `${awaiting.length} usuários estão aguardando liberação:`}
            </p>
            <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-sm text-muted-foreground">
              {awaiting.map((a) => (
                <li key={a.id}>{a.name}</li>
              ))}
            </ul>
            <button
              className="w-full rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground"
              onClick={() => setShowAlert(false)}
            >
              Entendi
            </button>
          </div>
        </div>
      )}

      {/* Modal: gerar / enviar chave */}
      {target && (
        <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/60 p-4 sm:items-center">
          <div
            className="w-full max-w-sm space-y-4 rounded-2xl bg-background p-5 shadow-xl"
            style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
          >
            <div>
              <h2 className="text-lg font-semibold">
                {target.key_generated_at ? "Regenerar chave" : "Gerar chave"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {target.name} · {target.email}
              </p>
            </div>

            {!generated ? (
              <>
                <fieldset className="space-y-2">
                  <legend className="mb-1 text-sm font-medium">Módulos liberados</legend>
                  {(Object.keys(MODULE_LABELS) as (keyof Modules)[]).map((m) => (
                    <label key={m} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={mods[m]}
                        onChange={(e) => setMods({ ...mods, [m]: e.target.checked })}
                      />
                      {MODULE_LABELS[m]}
                    </label>
                  ))}
                </fieldset>
                {target.key_generated_at && (
                  <p className="text-xs text-muted-foreground">
                    A chave anterior deixa de funcionar assim que a nova for gerada.
                  </p>
                )}
                <div className="flex gap-2">
                  <button className={`${btn} flex-1 py-2.5`} onClick={closeKeyModal}>
                    Cancelar
                  </button>
                  <button
                    className="flex-1 rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground disabled:opacity-60"
                    disabled={genBusy}
                    onClick={generate}
                  >
                    {genBusy ? "Gerando..." : "Gerar chave"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="rounded-lg bg-muted px-3 py-3 text-center">
                  <div className="font-mono text-xl font-semibold tracking-wider">{generated}</div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Esta chave aparece só agora e não fica guardada em texto. Copie ou envie antes de fechar.
                </p>
                <button
                  className={`w-full rounded-lg px-4 py-2.5 font-semibold transition-colors ${
                    copied ? "bg-green-600 text-white" : "bg-primary text-primary-foreground"
                  }`}
                  onClick={async () => {
                    if (await copyText(generated)) {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2200);
                    }
                  }}
                >
                  {copied ? "✓ Chave copiada!" : "Copiar chave"}
                </button>
                <a
                  href={mailtoHref()}
                  className="block w-full rounded-lg border border-border px-4 py-2.5 text-center font-semibold"
                >
                  Enviar por e-mail
                </a>
                <button className="w-full text-center text-sm text-muted-foreground underline" onClick={closeKeyModal}>
                  Fechar
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
