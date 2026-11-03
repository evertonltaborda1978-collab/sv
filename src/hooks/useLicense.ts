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

/**
 * Estado da licença do usuário logado.
 * Offline usa a última licença conhecida (o app precisa funcionar na fábrica sem internet).
 */
export function useLicense() {
  const [license, setLicense] = useState<MyLicense | null>(readCache());
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setEmail(data.session?.user?.email?.toLowerCase() ?? null);
    if (!data.session) {
      setLicense(null);
      try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
      setLoading(false);
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
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
