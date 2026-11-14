import { useCallback, useEffect, useRef, useState } from "react";
import { useLicense } from "@/hooks/useLicense";
import { adminList, adminPhones, showPhone, type LicenseRow } from "@/lib/license";

// Aviso na tela principal, só para o administrador: aparece enquanto houver pedido de licença
// aguardando decisão (pendente e sem chave gerada). Se você fechar, ele volta depois de alguns
// minutos, até você decidir (gerar a chave, colocar em espera ou bloquear).
// Para poupar a cota de tráfego, só consulta o servidor ao abrir o app, ao voltar para ele e a
// cada poucos minutos com o app aberto.

const SNOOZE_MS = 10 * 60_000; // ao fechar, volta em 10 minutos
const POLL_MS = 5 * 60_000; // confere a cada 5 minutos (só com o app visível)
const ALERT_FLAG = "sv_admin_alert_shown"; // o mesmo aviso de uma vez por sessão do painel

export default function PendingLicenseAlert({ onOpenPanel }: { onOpenPanel: () => void }) {
  const { loading, isAdmin } = useLicense();
  const [waiting, setWaiting] = useState<LicenseRow[]>([]);
  const [phones, setPhones] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(false);
  const snoozeUntil = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const check = useCallback(async () => {
    try {
      const rows = await adminList();
      const aw = rows.filter((r) => r.status === "pending" && !r.key_generated_at);
      setWaiting(aw);
      if (aw.length === 0) {
        setVisible(false);
        return;
      }
      adminPhones().then(setPhones);
      if (Date.now() >= snoozeUntil.current) setVisible(true);
    } catch {
      /* sem internet ou sem permissão: tenta de novo na próxima conferência */
    }
  }, []);

  useEffect(() => {
    if (loading || !isAdmin) return;
    check();
    const poll = setInterval(() => {
      if (!document.hidden) check();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", check);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", check);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loading, isAdmin, check]);

  // Fecha e agenda a volta do aviso
  const snooze = () => {
    setVisible(false);
    snoozeUntil.current = Date.now() + SNOOZE_MS;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(check, SNOOZE_MS + 500);
  };

  const openPanel = () => {
    try {
      sessionStorage.setItem(ALERT_FLAG, "1"); // evita o aviso duplicado dentro do painel
    } catch {}
    snooze(); // se sair do painel sem decidir, o aviso volta
    onOpenPanel();
  };

  if (loading || !isAdmin || !visible || waiting.length === 0) return null;

  const shown = waiting.slice(0, 3);
  const more = waiting.length - shown.length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-background p-5 shadow-xl">
        <h2 className="text-lg font-semibold">
          🔔 {waiting.length === 1 ? "Novo pedido de licença" : `${waiting.length} pedidos de licença aguardando`}
        </h2>
        <ul className="space-y-2">
          {shown.map((r) => (
            <li key={r.id} className="rounded-lg bg-muted px-3 py-2 text-sm">
              <div className="font-medium">{r.name}</div>
              <div className="break-all text-xs text-muted-foreground">{r.email}</div>
              {phones[r.id] && <div className="text-xs text-muted-foreground">📱 {showPhone(phones[r.id])}</div>}
            </li>
          ))}
        </ul>
        {more > 0 && <p className="text-xs text-muted-foreground">e mais {more}…</p>}
        <p className="text-xs text-muted-foreground">
          Este aviso volta a cada 10 minutos até você gerar a chave, colocar em espera ou bloquear.
        </p>
        <button
          className="w-full rounded-lg bg-primary px-4 py-2.5 font-semibold text-primary-foreground"
          onClick={openPanel}
        >
          Abrir painel de licenças
        </button>
        <button className="w-full text-center text-sm text-muted-foreground underline" onClick={snooze}>
          Fechar (lembrar em 10 minutos)
        </button>
      </div>
    </div>
  );
}
