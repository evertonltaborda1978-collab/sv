import { useState, useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoonPhaseWidget } from "@/components/MoonPhaseWidget";
import { useToast } from "@/hooks/use-toast";
import { useBiometricAuth } from "@/hooks/useBiometricAuth";
import { useVersionCheck } from "@/hooks/useVersionCheck";
import { APP_VERSION, VERSION_HISTORY, forceUpdateApp } from "@/lib/appVersion";
import PixSupport from "@/components/PixSupport";
import { APP_NAME, BLOCK_MESSAGES, activateLicense, checkKey, getMyLicense, registerDevice, requestLicense } from "@/lib/license";
import { Mail, Lock, User, Eye, EyeOff, Fingerprint, HelpCircle, X, RotateCcw, KeyRound } from "lucide-react";

// Alguns erros vêm crus e técnicos direto do navegador (ex: "Failed to
// fetch", quando não tem internet de verdade pra completar o login no
// servidor) — aqui trocamos por uma mensagem que a pessoa entende.
function friendlyAuthError(message: string | undefined): string {
  if (!message) return "Não foi possível completar. Tente novamente.";
  const raw = message.toLowerCase();
  if (raw.includes("failed to fetch") || raw.includes("networkerror") || raw.includes("load failed")) {
    return "Sem internet no momento. Conecte-se e tente entrar de novo.";
  }
  if (message === "Invalid login credentials") return "Email ou senha incorretos";
  if (raw.includes("weak") || raw.includes("easy to guess")) {
    return "Essa senha é muito comum e fácil de adivinhar. Escolha outra com pelo menos 8 caracteres, misturando letras maiúsculas e minúsculas, números e um símbolo (ex.: @ ou !). Evite sequências como 123456 ou palavras como \"senha\".";
  }
  if (raw.includes("at least") && raw.includes("password")) {
    return "A senha é curta demais. Use pelo menos 8 caracteres.";
  }
  if (raw.includes("email not confirmed")) {
    return "Seu email ainda não foi confirmado. Fale com o administrador.";
  }
  if (raw.includes("already registered")) {
    return "Este email já está cadastrado. Toque em Entrar.";
  }
  return message;
}

export default function Auth() {
  // login = entrar | request = obter licença | activate = ativar com a chave
  const [mode, setMode] = useState<"login" | "request" | "activate">("login");
  const isLogin = mode === "login";
  const [activationKey, setActivationKey] = useState("");
  const [keyValidated, setKeyValidated] = useState(false);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forgotPassword, setForgotPassword] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const { toast } = useToast();
  const { restoreSession } = useAuth();
  const { biometricEnabled, biometricAvailable, enableBiometric, disableBiometric, biometricLogin, storedEmail } = useBiometricAuth();
  const { notice: updateNotice } = useVersionCheck();

  // Aviso de atualização já na tela de login, sem precisar entrar com email/senha
  useEffect(() => {
    if (!updateNotice) return;
    toast({
      title: "✨ Aplicativo atualizado",
      description: updateNotice.from
        ? `Você está agora na versão ${updateNotice.to} (antes ${updateNotice.from}).`
        : `Você está agora na versão ${updateNotice.to}.`,
    });
  }, [updateNotice]);

  // Aviso quando a conta foi desconectada por não estar aprovada (ex.: a
  // pessoa clicou no link de confirmação do email antes da aprovação).
  const lastNoticeRef = useRef(0);
  useEffect(() => {
    const show = () => {
      let kind: string | null = null;
      try {
        kind = sessionStorage.getItem("approval_notice");
        sessionStorage.removeItem("approval_notice");
      } catch {}
      if (!kind) return;
      if (Date.now() - lastNoticeRef.current < 3000) return; // evita aviso duplicado
      lastNoticeRef.current = Date.now();
      toast({
        title: kind === "rejected" ? "Acesso não autorizado" : kind === "missing" ? "Conta não encontrada" : "Aguardando aprovação",
        description:
          kind === "rejected"
            ? "Seu acesso a este aplicativo não foi liberado pelo administrador."
            : kind === "missing"
            ? "Não encontramos esta conta. Fale com o administrador."
            : "Seu acesso ainda não foi liberado. Use a aba Ativar com a chave que o administrador enviou.",
        variant: "destructive",
      });
    };
    show();
    window.addEventListener("approval-notice", show);
    return () => window.removeEventListener("approval-notice", show);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeMode = (m: "login" | "request" | "activate") => {
    setMode(m);
    setForgotPassword(false);
    setPassword("");
    setConfirmPassword("");
    setActivationKey("");
    setKeyValidated(false);
  };

  const offerBiometric = async () => {
    if (biometricAvailable && !biometricEnabled) {
      const enabled = await enableBiometric(email, password);
      if (enabled) {
        toast({ title: "Biometria ativada!", description: "No próximo login, use sua biometria." });
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (forgotPassword) {
        const { error } = await (supabase.auth as any).resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}${import.meta.env.BASE_URL}reset-password`,
        });
        if (error) throw error;
        toast({ title: "Email enviado!", description: "Verifique sua caixa de entrada para redefinir a senha." });
        setForgotPassword(false);
        setLoading(false);
        return;
      }

      // 1) Obter Licença: só nome + e-mail; o pedido fica Pendente no servidor.
      if (mode === "request") {
        await requestLicense(fullName, email);
        toast({
          title: "Pedido enviado!",
          description: "Assim que o administrador liberar, você recebe a chave de ativação. Depois use a aba Ativar.",
        });
        setFullName("");
        changeMode("activate");
        setLoading(false);
        return;
      }

      // 2) Ativar: valida a chave no servidor e só então libera os campos de senha.
      if (mode === "activate") {
        if (!keyValidated) {
          const r = await checkKey(email.trim().toLowerCase(), activationKey.trim());
          setKeyValidated(true);
          toast({
            title: "Chave validada!",
            description: r.name ? `Olá, ${r.name.split(" ")[0]}! Agora crie sua senha definitiva.` : "Agora crie sua senha definitiva.",
          });
          setLoading(false);
          return;
        }
        if (password !== confirmPassword) {
          toast({
            title: "As senhas não são iguais",
            description: "Digite a mesma senha nos dois campos para evitar erro de digitação.",
            variant: "destructive",
          });
          setLoading(false);
          return;
        }
        await activateLicense(email.trim().toLowerCase(), activationKey.trim(), password);
        const { error } = await (supabase.auth as any).signInWithPassword({ email: email.trim().toLowerCase(), password });
        if (error) {
          toast({ title: "Senha criada!", description: "Agora é só entrar com seu e-mail e a nova senha." });
          setPassword("");
          setConfirmPassword("");
          setActivationKey("");
          setKeyValidated(false);
          setMode("login");
          setLoading(false);
          return;
        }
        await registerDevice();
        await offerBiometric();
        return;
      }

      // 3) Login diário: e-mail + senha definitiva.
      const { error } = await (supabase.auth as any).signInWithPassword({ email, password });
      if (error) throw error;

      // Portão de licença: só entra com licença ativa (o administrador sempre entra).
      const lic = await getMyLicense();
      if (!lic || lic.status !== "active") {
        await supabase.auth.signOut();
        lastNoticeRef.current = Date.now();
        toast({
          title: lic ? "Acesso não liberado" : "Não foi possível verificar a licença",
          description: lic
            ? BLOCK_MESSAGES[lic.status] ?? BLOCK_MESSAGES.none
            : "Confira sua conexão e tente de novo.",
          variant: "destructive",
        });
        setLoading(false);
        return;
      }
      await registerDevice();
      await offerBiometric();
    } catch (error: any) {
      toast({
        title: "Erro",
        description: friendlyAuthError(error.message),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleBiometricLogin = async () => {
    setLoading(true);
    const result = await biometricLogin();
    if (!result.success) {
      // A digital em si já confirmou quem é a pessoa (isso acontece antes
      // da parte que precisa de rede) — se só a etapa de confirmar com o
      // servidor falhou (sinal fraco/sem internet), tenta reaproveitar a
      // sessão que já estava guardada, em vez de deixar a pessoa presa.
      const restored = await restoreSession();
      if (!restored) {
        toast({ title: "Erro", description: friendlyAuthError(result.error), variant: "destructive" });
      }
    }
    setLoading(false);
  };

  const handleResetCache = async () => {
    if (!navigator.onLine) {
      toast({
        title: "Sem internet no momento",
        description: "Limpar o cache agora apagaria a cópia offline do app sem poder baixar uma nova. Tente de novo quando tiver conexão.",
      });
      return;
    }
    toast({
      title: "Atualizando aplicativo",
      description: "Limpando cache e buscando a versão mais recente...",
    });
    setTimeout(() => { void forceUpdateApp(); }, 600);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <MoonPhaseWidget />
          </div>
          <h1 className="text-2xl font-display font-bold text-foreground">
            {APP_NAME}
          </h1>
          <p className="text-sm text-muted-foreground">
            {forgotPassword
              ? "Recupere sua senha"
              : mode === "login"
              ? "Entre na sua conta"
              : mode === "request"
              ? "Peça sua licença de uso"
              : keyValidated
              ? "Crie sua senha definitiva"
              : "Ative com a chave recebida"}
          </p>
        </div>

        {/* Biometric quick login */}
        {isLogin && biometricEnabled && storedEmail && (
          <div className="space-y-2">
            <Button
              onClick={handleBiometricLogin}
              disabled={loading}
              className="w-full gap-2"
              variant="outline"
              style={{ borderColor: "#C8E6C9", background: "#F0FFF4" }}
            >
              <Fingerprint size={20} style={{ color: "#4CAF50" }} />
              <span style={{ color: "#2E7D32" }}>
                {loading ? "Autenticando..." : `Entrar como ${storedEmail}`}
              </span>
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">
              Digital não funcionando?{" "}
              <button
                type="button"
                onClick={() => {
                  disableBiometric();
                  toast({ title: "Biometria desativada", description: "Entre com email e senha — ela será oferecida de novo depois." });
                }}
                className="underline hover:text-foreground"
              >
                Desativar
              </button>
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted-foreground">ou use email</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "request" && !forgotPassword && (
            <div className="relative">
              <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Nome completo"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="pl-10"
                autoComplete="name"
                name="fullName"
                required
              />
            </div>
          )}
          <div className="relative">
            <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-10"
              autoComplete="username"
              name="email"
              required
              disabled={mode === "activate" && keyValidated}
            />
          </div>
          {mode === "activate" && !forgotPassword && (
            <div className="relative">
              <KeyRound size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Chave de ativação (SV-XXXX-XXXX-XXXX)"
                value={activationKey}
                onChange={(e) => setActivationKey(e.target.value.toUpperCase())}
                className="pl-10 font-mono"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                name="activationKey"
                required
                disabled={keyValidated}
              />
            </div>
          )}
          {((mode === "login" && !forgotPassword) || (mode === "activate" && keyValidated)) && (
            <div className="relative">
              <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type={showPassword ? "text" : "password"}
                placeholder={isLogin ? "Senha" : "Nova senha"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10 pr-10"
                autoComplete={isLogin ? "current-password" : "new-password"}
                name="password"
                required
                minLength={isLogin ? 1 : 8}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          )}
          {mode === "activate" && keyValidated && !forgotPassword && (
            <>
              <p className="text-[11px] text-muted-foreground -mt-2">
                Use pelo menos 8 caracteres, misturando letras, números e um símbolo (ex.: @ ou !). Evite sequências como 123456.
              </p>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Confirmar senha"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pl-10"
                  autoComplete="new-password"
                  name="confirmPassword"
                  required
                  minLength={8}
                />
              </div>
              {confirmPassword.length > 0 && confirmPassword !== password && (
                <p className="text-[11px] -mt-2" style={{ color: "#E53935" }}>As senhas não são iguais</p>
              )}
            </>
          )}
          {isLogin && !forgotPassword && (
            <div className="text-right">
              <button
                type="button"
                onClick={() => setForgotPassword(true)}
                className="text-xs text-primary hover:underline"
              >
                Esqueceu a senha?
              </button>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading
              ? "Aguarde..."
              : forgotPassword
              ? "Enviar email de recuperação"
              : mode === "login"
              ? "Entrar"
              : mode === "request"
              ? "Obter Licença"
              : keyValidated
              ? "Ativar e entrar"
              : "Validar chave"}
          </Button>
        </form>

        {/* Alternar entre Entrar / Obter Licença / Ativar */}
        <div className="text-center text-sm text-muted-foreground space-y-1.5">
          {forgotPassword ? (
            <button
              onClick={() => setForgotPassword(false)}
              className="text-primary font-semibold hover:underline"
            >
              Voltar ao login
            </button>
          ) : (
            <>
              {mode !== "login" && (
                <p>
                  Já tem conta?{" "}
                  <button onClick={() => changeMode("login")} className="text-primary font-semibold hover:underline">
                    Entrar
                  </button>
                </p>
              )}
              {mode !== "request" && (
                <p>
                  Ainda não tem licença?{" "}
                  <button onClick={() => changeMode("request")} className="text-primary font-semibold hover:underline">
                    Obter Licença
                  </button>
                </p>
              )}
              {mode !== "activate" && (
                <p>
                  Recebeu uma chave?{" "}
                  <button onClick={() => changeMode("activate")} className="text-primary font-semibold hover:underline">
                    Ativar
                  </button>
                </p>
              )}
              {mode === "activate" && keyValidated && (
                <button
                  onClick={() => { setKeyValidated(false); setPassword(""); setConfirmPassword(""); }}
                  className="text-xs underline hover:text-foreground"
                >
                  Usar outra chave
                </button>
              )}
            </>
          )}
        </div>

        <div className="flex justify-center">
          <PixSupport />
        </div>

        <p className="text-center text-xs text-muted-foreground/60 pt-4">
          Criado por <span className="font-semibold text-muted-foreground/80">Everton Taborda</span>
        </p>

        {/* Versão do app + histórico de atualizações + botão de limpar cache */}
        <div className="flex items-center justify-center gap-1.5 pt-1">
          <span className="text-[10px] text-muted-foreground/50 font-semibold">{APP_VERSION}</span>
          <button
            onClick={() => setShowVersionHistory(true)}
            className="flex items-center justify-center rounded-full text-muted-foreground/50 hover:text-muted-foreground"
            title="Ver histórico de versões"
          >
            <HelpCircle size={13} />
          </button>
          <button
            onClick={handleResetCache}
            className="flex items-center justify-center rounded-full text-muted-foreground/50 hover:text-red-500"
            title="Limpar cache e cookies (se não estiver mostrando a versão mais nova)"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {showVersionHistory && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setShowVersionHistory(false)}
        >
          <div className="w-full max-w-sm rounded-2xl p-5 bg-background" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-sm text-foreground">📋 Histórico de versões</h3>
              <button onClick={() => setShowVersionHistory(false)} className="p-1 rounded-full hover:bg-black/5">
                <X size={18} className="text-muted-foreground" />
              </button>
            </div>
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {VERSION_HISTORY.map((v) => (
                <div key={v.version} className="flex gap-2">
                  <span className="text-xs font-bold text-primary shrink-0">{v.version}</span>
                  <p className="text-xs text-muted-foreground">{v.changes}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
