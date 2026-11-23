import { Capacitor, registerPlugin } from "@capacitor/core";

// Ferramentas de tela do Android (plugin nativo UiToolsPlugin.java). No navegador/PWA, ou se o
// app instalado ainda for uma versão sem o plugin, tudo aqui falha em silêncio e o app segue normal.
type UiToolsType = {
  enterImmersive(): Promise<void>;
  exitImmersive(): Promise<void>;
  setSelectionMenuHidden(o: { hidden: boolean }): Promise<void>;
  getClipboardText(): Promise<{ text: string }>;
  startReadAloudService(o: { seconds: number }): Promise<void>;
  stopReadAloudService(): Promise<void>;
};

const UiTools = registerPlugin<UiToolsType>("UiTools");

const native = () => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
};

// Esconde relógio e botões do Android (foto ampliada)
export function enterImmersive(): void {
  if (!native()) return;
  UiTools.enterImmersive().catch(() => {});
}

// Devolve relógio e botões do Android
export function exitImmersive(): void {
  if (!native()) return;
  UiTools.exitImmersive().catch(() => {});
}

// Liga/desliga o menu nativo de Copiar/Recortar do Android. Devolve true se o plugin respondeu.
export async function setSelectionMenuHidden(hidden: boolean): Promise<boolean> {
  if (!native()) return false;
  try {
    await UiTools.setSelectionMenuHidden({ hidden });
    return true;
  } catch {
    return false;
  }
}

// Texto que está na área de transferência (null se não deu para ler)
export async function readClipboardText(): Promise<string | null> {
  if (native()) {
    try {
      const r = await UiTools.getClipboardText();
      return r?.text ?? "";
    } catch {
      // cai para o método do navegador
    }
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

// Leitura em voz alta com a tela bloqueada: liga/desliga o serviço em primeiro plano do Android
// (notificação fixa "Lendo a nota em voz alta"). "seconds" = quanto tempo a leitura deve durar.
export function startReadAloudService(seconds: number): void {
  if (!native()) return;
  UiTools.startReadAloudService({ seconds: Math.round(seconds) }).catch(() => {});
}

export function stopReadAloudService(): void {
  if (!native()) return;
  UiTools.stopReadAloudService().catch(() => {});
}
