import { supabase } from "@/integrations/supabase/client";

// As funções de licenciamento não estão nos tipos gerados do Supabase.
const sb = supabase as any;

export const APP_NAME = "Secretária Virtual";
export const APP_SHORT = "Secretária";
export const APP_URL = "https://evertonltaborda1978-collab.github.io/sv/";
export const ADMIN_EMAIL = "evertonltaborda@gmail.com"; // painel e acesso total
export const BACKOFFICE_EMAIL = "evertontab@gmail.com"; // só PIX/licenças, não entra no app

export type LicenseStatus = "pending" | "active" | "blocked" | "on_hold" | "none" | "backoffice";

// Cada módulo = uma aba/recurso do app que pode ser liberado ou bloqueado por usuário.
// "Notas" fica sempre liberada.
export type ModuleKey =
  | "agenda"
  | "combustivel"
  | "saude"
  | "tempo"
  | "local"
  | "seguranca"
  | "turno";

export type Modules = Record<ModuleKey, boolean>;

export const MODULE_ORDER: ModuleKey[] = [
  "agenda",
  "combustivel",
  "saude",
  "tempo",
  "local",
  "seguranca",
  "turno",
];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  agenda: "Agenda",
  combustivel: "Combustível",
  saude: "Saúde",
  tempo: "Tempo",
  local: "Local",
  seguranca: "Segurança",
  turno: "Relatório de Turno",
};

export const ALL_MODULES: Modules = {
  agenda: true, combustivel: true, saude: true, tempo: true, local: true, seguranca: true, turno: true,
};

export const EMPTY_MODULES: Modules = {
  agenda: false, combustivel: false, saude: false, tempo: false, local: false, seguranca: false, turno: false,
};

/** Completa módulos de licenças antigas (que só tinham saude/seguranca/agenda). */
export function normalizeModules(m?: Partial<Modules> | null): Modules {
  const x = (m ?? {}) as Partial<Modules>;
  return {
    agenda: !!x.agenda,
    saude: !!x.saude,
    seguranca: !!x.seguranca,
    local: x.local ?? !!x.seguranca, // antes a aba Local seguia a Segurança
    combustivel: x.combustivel ?? true, // abas que antes não eram controladas
    tempo: x.tempo ?? true,
    turno: x.turno ?? true,
  };
}

export interface MyLicense {
  status: LicenseStatus;
  is_admin: boolean;
  modules: Modules;
}

export interface LicenseRow {
  id: string;
  name: string;
  email: string;
  status: "pending" | "active" | "blocked" | "on_hold";
  modules: Modules;
  key_generated_at: string | null;
  key_used_at: string | null;
  activated_at: string | null;
  last_access: string | null;
  created_at: string;
  device_count: number;
}

// ID estável do aparelho (guardado no localStorage)
export function getDeviceId(): string {
  const k = "sv_device_id";
  try {
    let id = localStorage.getItem(k);
    if (!id) {
      id =
        (crypto as any)?.randomUUID?.() ??
        `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(k, id!);
    }
    return id!;
  } catch {
    return "unknown";
  }
}

// ---------- Usuário ----------
export async function requestLicense(name: string, email: string): Promise<void> {
  const { error } = await sb.rpc("request_license", { p_name: name, p_email: email });
  if (error) throw new Error(error.message?.includes("inválido") ? error.message : "Não foi possível enviar o pedido.");
}

async function callLicenseFn(body: Record<string, string>) {
  const { data, error } = await supabase.functions.invoke("license", { body });
  if (error) throw new Error("Sem conexão com o servidor. Tente de novo.");
  if (!data?.ok) throw new Error(data?.error ?? "Chave inválida.");
  return data as { ok: true; name?: string };
}

export const checkKey = (email: string, key: string) =>
  callLicenseFn({ action: "check", email, key });

export const activateLicense = (email: string, key: string, password: string) =>
  callLicenseFn({ action: "activate", email, key, password });

export async function getMyLicense(): Promise<MyLicense | null> {
  const { data, error } = await sb.rpc("get_my_license");
  if (error || !data) return null;
  return data as MyLicense;
}

export async function registerDevice(): Promise<void> {
  try {
    await sb.rpc("register_device", { p_device_id: getDeviceId() });
  } catch {
    /* offline: tenta de novo no próximo login */
  }
}

// ---------- Admin ----------
export async function adminList(): Promise<LicenseRow[]> {
  const { data, error } = await sb.rpc("admin_list_licenses");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => ({ ...r, device_count: Number(r.device_count) }));
}

export async function adminGenerateKey(id: string, modules: Modules): Promise<string> {
  const { data, error } = await sb.rpc("admin_generate_key", { p_id: id, p_modules: modules });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function adminSetStatus(id: string, action: "block" | "unblock" | "hold") {
  const { error } = await sb.rpc("admin_set_status", { p_id: id, p_action: action });
  if (error) throw new Error(error.message);
}

export async function adminUpdateModules(id: string, modules: Modules) {
  const { error } = await sb.rpc("admin_update_modules", { p_id: id, p_modules: modules });
  if (error) throw new Error(error.message);
}

export const BLOCK_MESSAGES: Record<string, string> = {
  pending: "Seu acesso ainda não foi ativado. Use a aba Ativar com a chave recebida.",
  blocked: "Este acesso está bloqueado. Fale com o administrador.",
  on_hold: "Seu pedido está em espera. Aguarde o contato do administrador.",
  none: "Nenhuma licença encontrada para este e-mail. Peça a sua em Obter Licença.",
  backoffice: "Este e-mail é só de retaguarda (PIX e licenças) e não entra no app. Use o e-mail de uso diário.",
};
