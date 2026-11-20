import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ADMIN_EMAIL, EMPTY_MODULES, getMyLicense, normalizeModules, type ModuleKey, type Modules, type MyLicense } from "@/lib/license";

const CACHE_KEY = "sv_license_cache";

function readCache(): MyLicense | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as MyLicense) : null;
  } catch {
    return null;
  }
}

// E-mail da sessão guardada no aparelho (sem chamar a rede).
function readCachedEmail(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("sb-") && key.endsWith("-auth-token")) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const session = parsed?.currentSession || parsed;
        const mail = session?.user?.email;
        if (mail) return String(mail).toLowerCase();
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Espera no máximo "ms" milissegundos; se estourar ou der erro, usa o valor reserva.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }).catch(() => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * Estado da licença do usuário logado.
 * Offline usa a última licença conhecida (o app precisa funcionar na fábrica sem internet).
 */
export function useLicense() {
  const [license, setLicense] = useState<MyLicense | null>(readCache());
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(readCachedEmail());

  const refresh = useCallback(async () => {
    // Sem internet: não chama o Supabase (o getSession dele ficaria
    // tentando renovar o token pela rede e travaria). Usa o que está guardado.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setEmail(readCachedEmail());
      setLoading(false);
      return;
    }
    const { data } = await withTimeout<any>(
      supabase.auth.getSession(),
      4000,
      { data: { session: null }, timedOut: true }
    ).then((r: any) => (r?.timedOut ? { data: { session: undefined, timedOut: true } } : r));
    if (data?.timedOut) {
      // Sinal fraco demais: segue com a última licença conhecida.
      setEmail(readCachedEmail());
      setLoading(false);
      return;
    }
    setEmail(data.session?.user?.email?.toLowerCase() ?? null);
    if (!data.session) {
      setLicense(null);
      try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
      setLoading(false);
      return;
    }
    const fresh = await getMyLicense();
    if (fresh) {
      setLicense(fresh);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(fresh)); } catch { /* ignore */ }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      setTimeout(refresh, 0);
    });
    window.addEventListener("online", refresh);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("online", refresh);
    };
  }, [refresh]);

  const modules: Modules = license ? normalizeModules(license.modules) : EMPTY_MODULES;
  // Administrador: somente o e-mail principal (evertonltaborda@gmail.com).
  // A segurança de verdade está no servidor: as funções do painel só respondem a ele.
  const isAdmin = !!email && email === ADMIN_EMAIL.toLowerCase();

  return {
    license,
    loading,
    refresh,
    email,
    isAdmin,
    isActive: license?.status === "active",
    hasModule: (m: ModuleKey) => isAdmin || !!modules[m],
  };
}
