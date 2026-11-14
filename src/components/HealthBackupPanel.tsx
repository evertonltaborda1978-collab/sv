import { useRef, useState, type CSSProperties } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { buildBackup, lastBackupAt, restoreBackup, shareBackup } from "@/lib/healthBackup";

// Painel de backup da aba Saúde: gera um arquivo com consultas, anexos, remédios e horários
// e restaura a partir dele. Aparece ao tocar no botão 💾 ao lado do "Aa".

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function HealthBackupPanel({ scale }: { scale: number }) {
  const { user } = useAuth();
  const fs = (px: number) => Math.round(px * scale * 10) / 10;
  const [busy, setBusy] = useState<"" | "export" | "restore">("");
  const [last, setLast] = useState<Date | null>(() => (user ? lastBackupAt(user.id) : null));
  const fileRef = useRef<HTMLInputElement>(null);

  const btn: CSSProperties = {
    flex: 1, minHeight: 52, borderRadius: 12, cursor: "pointer", fontSize: fs(14), fontWeight: 600,
    border: "1px solid var(--color-border-secondary)", background: "transparent", color: "var(--color-text-primary)",
  };

  const doExport = async () => {
    if (!user || busy) return;
    setBusy("export");
    try {
      const { blob, name, stats } = await buildBackup(user.id);
      const r = await shareBackup(blob, name);
      setLast(lastBackupAt(user.id));
      if (r === "failed") {
        toast({ title: "Não consegui enviar o backup", description: "Tente de novo. Nada foi apagado.", variant: "destructive" });
        return;
      }
      const resumo = `${stats.visits} atendimento(s), ${stats.meds} remédio(s), ${stats.files} anexo(s).`;
      if (stats.missingFiles.length > 0) {
        toast({
          title: "Backup gerado, mas faltaram anexos",
          description: `${resumo} Não consegui incluir: ${stats.missingFiles.slice(0, 3).join(", ")}${stats.missingFiles.length > 3 ? "…" : ""}`,
          variant: "destructive",
        });
      } else {
        toast({ title: r === "saved" ? "✅ Backup baixado" : "✅ Backup pronto", description: `${resumo} Guarde o arquivo no Google Drive.` });
      }
    } catch {
      toast({ title: "Não consegui gerar o backup", description: "Nada foi apagado.", variant: "destructive" });
    } finally {
      setBusy("");
    }
  };

  const doRestore = async (file: File | undefined) => {
    if (!user || !file || busy) return;
    setBusy("restore");
    try {
      const s = await restoreBackup(user.id, file);
      toast({
        title: "✅ Backup restaurado",
        description: `Entraram ${s.visits} atendimento(s), ${s.meds} remédio(s) e ${s.files} anexo(s). O app vai recarregar.`,
      });
      setTimeout(() => window.location.reload(), 1600);
    } catch (e: any) {
      toast({ title: "Não consegui restaurar", description: e?.message || "Arquivo inválido.", variant: "destructive" });
      setBusy("");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div style={{ background: "var(--color-background-secondary)", border: "1px solid var(--color-border-secondary)", borderRadius: 14, padding: 12, marginBottom: 12 }}>
      <div style={{ fontSize: fs(15), fontWeight: 700, marginBottom: 4, color: "var(--color-text-primary)" }}>💾 Backup da Saúde</div>
      <div style={{ fontSize: fs(13), color: "var(--color-text-secondary)", marginBottom: 10 }}>
        Guarda num arquivo as consultas, os anexos (atestados, receitas, exames), os remédios e os horários. Salve o arquivo no Google Drive ou mande para você mesmo.
        {last ? ` Último backup: ${fmt(last)}.` : " Você ainda não fez nenhum backup neste aparelho."}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={doExport} disabled={!!busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {busy === "export" ? "Gerando…" : "Exportar backup"}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={!!busy} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
          {busy === "restore" ? "Restaurando…" : "Restaurar backup"}
        </button>
      </div>
      <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
        onChange={(e) => doRestore(e.target.files?.[0])} />
      <div style={{ fontSize: fs(12), color: "var(--color-text-secondary)", marginTop: 8 }}>
        Restaurar só adiciona o que estiver faltando, e nunca apaga o que já existe.
      </div>
    </div>
  );
}
