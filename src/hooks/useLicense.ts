import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { EMPTY_MODULES, getMyLicense, type Modules, type MyLicense } from "@/lib/license";

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

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
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

  const modules: Modules = license?.modules ?? EMPTY_MODULES;

  return {
    license,
    loading,
    refresh,
    isAdmin: !!license?.is_admin,
    isActive: license?.status === "active",
    hasModule: (m: keyof Modules) => !!license?.is_admin || !!modules[m],
  };
}
