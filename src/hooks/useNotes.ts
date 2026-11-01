import { useState, useCallback, useEffect, useRef } from "react";
import { SnoozeAlertData } from "@/components/SnoozeAlert";
import { supabase } from "@/integrations/supabase/client";
import { idbLer, idbGravar } from "@/lib/notasCache";
import { useAuth } from "@/contexts/AuthContext";
import { encryptNote, decryptNote, isEncrypted, LockPayload } from "@/lib/noteCrypto";
import type { AlertSoundId } from "@/lib/alertSound";
import { shareOrSaveTextFile } from "@/lib/nativeShare";
import { toast } from "@/hooks/use-toast";

export interface Note {
  id: string;
  title: string;
  content: string;
  images: string[];
  createdAt: Date;
  updatedAt: Date;
  color: string;
  fontFamily: string;
  fontSize: string;
  status: "rascunho" | "publicada";
  sincronizado: boolean;
  reminderDate?: string | null;
  reminderTime?: string | null;
  reminderSound?: AlertSoundId;
  /** Som do alarme NATIVO (toca com o app fechado) escolhido para esse
   * lembrete em particular — null/undefined usa o padrão do sistema. */
  reminderNativeSoundUri?: string | null;
  reminderNativeSoundName?: string | null;
  isLocked: boolean;
  lockSalt?: string | null;
  deletedAt?: Date | null;
  isPinned: boolean;
  pinOrder?: number | null;
}

const COLORS = [
  "bg-yellow-100",
  "bg-blue-100",
  "bg-green-100",
  "bg-pink-100",
  "bg-orange-100",
  "bg-purple-100",
];

export type SyncStatus = "synced" | "syncing" | "offline";

function getLocalKey(userId: string) {
  return `notas_usuario_${userId}`;
}

type ResultadoCache = { status: "idb" | "completo" | "parcial" | "falhou"; kb: number };

function saveLocal(userId: string, notes: Note[]): ResultadoCache {
  const key = getLocalKey(userId);
  try {
    const json = JSON.stringify(notes);
    localStorage.setItem(key, json);
    return { status: "completo", kb: Math.round(json.length / 1024) };
  } catch {
    // Provável estouro de espaço do navegador (fotos em base64 dentro das notas).
    // Nesse caso salvamos o TEXTO das notas sem as imagens — melhor ter as notas
    // legíveis offline do que não ter nada.
  }
  try {
    const json = JSON.stringify(notes.map((n) => ({ ...n, images: [] })));
    localStorage.setItem(key, json);
    return { status: "parcial", kb: Math.round(json.length / 1024) };
  } catch {
    // Ainda não coube: guarda apenas as 100 notas mais recentes, sem imagens.
  }
  try {
    const json = JSON.stringify(
      notes
        .slice()
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .slice(0, 100)
        .map((n) => ({ ...n, images: [] }))
    );
    localStorage.setItem(key, json);
    return { status: "parcial", kb: Math.round(json.length / 1024) };
  } catch {
    return { status: "falhou", kb: 0 };
  }
}


// Transforma o que veio do armazenamento (datas viram Date de novo) em notas de verdade.
function reviverNotas(parsed: any): Note[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((n: any) => ({
    ...n,
    images: [], // a lista separada de fotos duplicava tudo; as fotos ficam dentro do texto (content)
    createdAt: new Date(n.createdAt),
    updatedAt: new Date(n.updatedAt),
    deletedAt: n.deletedAt ? new Date(n.deletedAt) : null,
  }));
}

function loadLocal(userId: string): Note[] {
  try {
    const raw = localStorage.getItem(getLocalKey(userId));
    if (!raw) return [];
    return reviverNotas(JSON.parse(raw));
  } catch {
    return [];
  }
}

// Cópia grande no IndexedDB (sem o limite de ~5 MB); se não houver lá, tenta o armazenamento comum.
async function lerCacheCompleto(userId: string): Promise<Note[]> {
  const doIdb = await idbLer<any[]>(getLocalKey(userId));
  if (Array.isArray(doIdb) && doIdb.length > 0) return reviverNotas(doIdb);
  return loadLocal(userId);
}

// Grava a cópia no IndexedDB. Se não der, cai para o armazenamento comum (como antes).
async function gravarCacheNoAparelho(userId: string, lista: Note[]): Promise<ResultadoCache> {
  const chave = getLocalKey(userId);
  const ok = await idbGravar(chave, lista);
  if (ok) {
    try { localStorage.removeItem(chave); } catch { /* ignora */ } // libera o armazenamento pequeno
    const kb = Math.round(lista.reduce((s, n) => s + n.content.length + n.title.length, 0) / 1024);
    return { status: "idb", kb };
  }
  return saveLocal(userId, lista);
}

// Uma vez só: passa para o IndexedDB as cópias antigas (de outras contas) que estavam
// ocupando o armazenamento comum e impedindo a cópia nova de caber.
async function migrarCachesAntigos(userIdAtual: string): Promise<void> {
  try {
    const chaves: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("notas_usuario_") && k !== getLocalKey(userIdAtual) && k !== getLocalKey("anon")) chaves.push(k);
    }
    for (const k of chaves) {
      const raw = localStorage.getItem(k);
      if (!raw) { localStorage.removeItem(k); continue; }
      let lista: Note[] = [];
      try { lista = reviverNotas(JSON.parse(raw)); } catch { continue; }
      if (lista.length === 0) { localStorage.removeItem(k); continue; }
      if (await idbGravar(k, lista)) localStorage.removeItem(k);
    }
  } catch { /* migração é só uma faxina: se falhar, tenta de novo em outra hora */ }
}

// Offline sem sessão restaurada: procura o último conjunto de notas salvo neste
// aparelho (qualquer usuário), para nunca mostrar tela vazia por falta de login.
function loadAnyLocal(): Note[] {
  try {
    const lastUser = localStorage.getItem("ultimo_usuario_id");
    // Se já sabemos qual foi a última conta deste aparelho, usa SÓ o cache dela
    // (mesmo que seja pequeno). Antes, quando ele estava vazio, o app pegava o
    // maior cache de QUALQUER conta e mostrava as notas de outra conta ao abrir.
    if (lastUser) return loadLocal(lastUser);
    let best: Note[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith("notas_usuario_")) continue;
      const found = loadLocal(key.replace("notas_usuario_", ""));
      if (found.length > best.length) best = found;
    }
    return best;
  } catch {
    return [];
  }
}


// Exclusões definitivas que ainda não chegaram ao servidor (internet ruim ou
// sem sinal). Ficam guardadas no aparelho e são reenviadas quando a internet
// voltar. Sem isso, a nota era apagada só na tela e o servidor continuava com
// ela — e ela "voltava" na próxima atualização, mesmo com a lixeira esvaziada.
const pendingDeletesKey = (uid: string) => `notas_exclusoes_pendentes_${uid}`;
function loadPendingDeletes(uid: string): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(pendingDeletesKey(uid)) || "[]");
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}
function savePendingDeletes(uid: string, ids: string[]) {
  try {
    const unicos = Array.from(new Set(ids));
    if (unicos.length === 0) localStorage.removeItem(pendingDeletesKey(uid));
    else localStorage.setItem(pendingDeletesKey(uid), JSON.stringify(unicos));
  } catch {}
}

function mergeNotes(local: Note[], remote: Note[]): Note[] {
  const map = new Map<string, Note>();
  for (const n of remote) map.set(n.id, { ...n, sincronizado: true });
  for (const n of local) {
    const existing = map.get(n.id);
    if (!existing) {
      map.set(n.id, n);
    } else if (!n.sincronizado || n.updatedAt >= existing.updatedAt) {
      // Fixar/desafixar não muda a data de "atualizada em" no servidor. Por isso,
      // se a nota daqui não tem nenhuma mudança pendente, quem manda na fixação é
      // o servidor — senão a fixação feita no outro aparelho nunca chegava (a
      // cópia daqui "parecia" igual ou mais nova) e depois era desfeita.
      map.set(n.id, n.sincronizado ? { ...n, isPinned: existing.isPinned, pinOrder: existing.pinOrder } : n);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

function mapRow(n: any): Note {
  return {
    id: n.id,
    title: n.title,
    content: n.content ?? "",
    images: n.images || [],
    createdAt: new Date(n.created_at),
    updatedAt: new Date(n.updated_at),
    color: n.color || COLORS[0],
    fontFamily: n.font_family || "default",
    fontSize: n.font_size || "medium",
    status: n.status || "publicada",
    sincronizado: true,
    reminderDate: n.reminder_date || null,
    reminderTime: n.reminder_time || null,
    reminderSound: (n.reminder_sound || "classico") as AlertSoundId,
    reminderNativeSoundUri: n.reminder_native_sound_uri || null,
    reminderNativeSoundName: n.reminder_native_sound_name || null,
    isLocked: n.is_locked || false,
    lockSalt: n.lock_salt || null,
    deletedAt: n.deleted_at ? new Date(n.deleted_at) : null,
    isPinned: n.is_pinned || false,
    pinOrder: n.pin_order ?? null,
  };
}

// Colunas baixadas na atualização da lista: só as informações PEQUENAS de cada
// nota. O corpo (content), onde ficam as fotos em base64, e a lista de fotos
// (images) ficam de fora: eram eles que faziam cada atualização baixar megabytes.
// Corpo e fotos só são baixados para notas novas ou alteradas em outro aparelho.
const COLUNAS_LISTA =
  "id, title, color, font_family, font_size, status, created_at, updated_at, " +
  "reminder_date, reminder_time, reminder_sound, reminder_native_sound_uri, reminder_native_sound_name, " +
  "is_locked, lock_salt, deleted_at, is_pinned, pin_order";

// Nota na lixeira há mais de 30 dias: já deveria ter sido apagada de vez.
const LIXEIRA_MS = 30 * 24 * 60 * 60 * 1000;
const lixeiraVencida = (n: { deletedAt?: Date | string | null }) => {
  if (!n.deletedAt) return false;
  const t = new Date(n.deletedAt).getTime();
  return !isNaN(t) && Date.now() - t > LIXEIRA_MS;
};

// ── Cronômetro de abertura: toque no número da versão (tela de notas) para ver ──
// Os tempos contam desde o início do carregamento da página (inclui o app subindo).
const marcasAbertura: {
  jsPronto: number; cacheMs: number; usuarioPronto?: number; listaNaTela?: number; servidorOk?: number;
  cacheStatus?: string; cacheKB?: number; listasBaixadas: number; corposBaixados: number; corposKB: number;
} = {
  jsPronto: Math.round(performance.now()),
  cacheMs: 0,
  listasBaixadas: 0,
  corposBaixados: 0,
  corposKB: 0,
};
const agoraMs = () => Math.round(performance.now());
export function lerMarcasAbertura() {
  let domPronto: number | undefined;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.domContentLoadedEventEnd > 0) domPronto = Math.round(nav.domContentLoadedEventEnd);
  } catch { /* ignora */ }
  return { ...marcasAbertura, domPronto };
}

// "Assinatura" barata de uma lista de notas: muda sempre que algo que aparece ou é
// salvo muda (texto, fixação, lixeira, lembrete, cadeado...). Serve para não
// regravar no celular a cópia inteira (vários MB) quando nada mudou.
function assinaturaNotas(userId: string, lista: Note[]): string {
  return userId + "#" + lista.map((n) => [
    n.id, n.updatedAt.getTime(), n.sincronizado ? 1 : 0, n.isPinned ? 1 : 0, n.pinOrder ?? "",
    n.deletedAt ? new Date(n.deletedAt).getTime() : 0, n.isLocked ? 1 : 0, n.lockSalt ?? "",
    n.title, n.color, n.fontFamily, n.fontSize, n.status, n.content.length,
    n.reminderDate ?? "", n.reminderTime ?? "", n.reminderSound ?? "",
    n.reminderNativeSoundUri ?? "", n.reminderNativeSoundName ?? "",
  ].join("~")).join("|");
}

// Cópia guardada no celular da ÚLTIMA conta que usou o app, lida antes da primeira
// tela aparecer: a lista já nasce preenchida em vez de abrir com "0 notas".
function lerCacheInicial(): { userId: string | null; notas: Note[] } {
  const t0 = performance.now();
  try {
    const ultimo = localStorage.getItem("ultimo_usuario_id");
    if (!ultimo) return { userId: null, notas: [] };
    return { userId: ultimo, notas: loadLocal(ultimo).filter((n) => !lixeiraVencida(n)) };
  } catch {
    return { userId: null, notas: [] };
  } finally {
    marcasAbertura.cacheMs = Math.round(performance.now() - t0);
  }
}

export function useNotes() {
  const { user } = useAuth();
  const [cacheInicial] = useState(lerCacheInicial);
  const [notes, setNotes] = useState<Note[]>(cacheInicial.notas);
  const [loading, setLoading] = useState(cacheInicial.notas.length === 0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("synced");
  // Guarda qual nota falhou ao sincronizar e o motivo exato (mensagem que
  // vem do próprio banco), pra dar um jeito de ver o que está travando em
  // vez de só saber que "tem 1 pendente" sem saber por quê.
  const [lastSyncError, setLastSyncError] = useState<{ title: string; message: string } | null>(null);
  const syncingRef = useRef(false);
  // Último "atualizada em" de cada nota que ESTE aparelho viu no servidor. Serve
  // para distinguir "alguém mexeu na nota em outro lugar" (aí a cópia daqui é
  // antiga e não deve sobrescrever) de "o relógio do celular está atrasado em
  // relação ao servidor" (aí a mudança feita agora é legítima e deve valer).
  const serverSeenRef = useRef<Map<string, number>>(new Map());
  // Notas excluídas de vez nesta sessão. Marcado NA HORA (a cópia rápida das
  // notas só se atualiza quando a tela redesenha), para um envio que ainda está
  // em andamento não recriar uma nota que a pessoa acabou de excluir.
  const deletedIdsRef = useRef<Set<string>>(new Set());
  // O que a pessoa pediu pra fixar/desafixar/reordenar. É uma ação dela e não
  // pode se perder por diferença de relógio entre o celular e o servidor.
  const pinIntentRef = useRef<Map<string, { isPinned: boolean; pinOrder: number | null }>>(new Map());
  const notesRef = useRef<Note[]>(cacheInicial.notas);
  // Preenche a lista com a cópia do IndexedDB assim que o app abre.
  useEffect(() => {
    if (cacheInicial.notas.length > 0) return; // já nasceu preenchida pela cópia pequena
    let ultimo: string | null = null;
    try { ultimo = localStorage.getItem("ultimo_usuario_id"); } catch { /* ignora */ }
    if (!ultimo) return;
    const donoDaCopia = ultimo;
    const t0 = performance.now();
    hidratacaoRef.current = (async () => {
      const doIdb = await idbLer<any[]>(getLocalKey(donoDaCopia));
      marcasAbertura.cacheMs = Math.round(performance.now() - t0);
      if (Array.isArray(doIdb) && doIdb.length > 0 && notesRef.current.length === 0) {
        const notas = reviverNotas(doIdb).filter((n) => !lixeiraVencida(n));
        if (notas.length === 0) return;
        cacheUserIdRef.current = donoDaCopia;
        hidratadoNotasRef.current = notas;
        ultimaGravacaoRef.current = assinaturaNotas(donoDaCopia, notas);
        setNotesAndRef(notas);
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cronômetro: quando a lista apareceu com notas pela primeira vez.
  useEffect(() => {
    if (marcasAbertura.listaNaTela === undefined && notes.length > 0) marcasAbertura.listaNaTela = agoraMs();
  }, [notes]);
  // Assinatura do que já está gravado no celular (começa igual à cópia que foi lida).
  const ultimaGravacaoRef = useRef<string>(assinaturaNotas(cacheInicial.userId || "", cacheInicial.notas));
  const filaGravacaoRef = useRef<Promise<void>>(Promise.resolve());
  const migracaoIniciadaRef = useRef(false);
  const cacheInicialUsadaRef = useRef(false);
  // Quando a cópia pequena não existe (a grande mora no IndexedDB), a lista começa
  // "Carregando…" e é preenchida em poucas dezenas de milissegundos, sem esperar a internet.
  const hidratacaoRef = useRef<Promise<void>>(Promise.resolve());
  const hidratadoNotasRef = useRef<Note[] | null>(null);
  // Grava a cópia no aparelho SÓ se algo mudou. As gravações entram numa fila (uma de cada
  // vez), no IndexedDB, que não tem o limite de ~5 MB do armazenamento comum.
  const gravarCache = useCallback((userId: string, lista: Note[]) => {
    let precisaMigrar = false;
    try { precisaMigrar = localStorage.getItem("cache_idb_v1") !== "1"; } catch { /* ignora */ }
    const sig = assinaturaNotas(userId, lista);
    if (sig === ultimaGravacaoRef.current && (!precisaMigrar || migracaoIniciadaRef.current)) return;
    if (precisaMigrar) migracaoIniciadaRef.current = true;
    ultimaGravacaoRef.current = sig; // marca já, para não enfileirar a mesma gravação duas vezes
    filaGravacaoRef.current = filaGravacaoRef.current
      .then(async () => {
        const r = await gravarCacheNoAparelho(userId, lista);
        marcasAbertura.cacheStatus = r.status;
        marcasAbertura.cacheKB = r.kb;
        if (r.status === "falhou") {
          ultimaGravacaoRef.current = ""; // tenta de novo na próxima mudança
          migracaoIniciadaRef.current = false;
          return;
        }
        if (precisaMigrar) {
          if (r.status === "idb") await migrarCachesAntigos(userId);
          try { localStorage.setItem("cache_idb_v1", "1"); } catch { /* ignora */ }
        }
      })
      .catch(() => { /* gravação falhou: tenta de novo na próxima mudança */ });
  }, []);
  // De qual conta é a cópia inicial: se a conta que entrar for outra, ela é descartada.
  const cacheUserIdRef = useRef<string | null>(cacheInicial.notas.length > 0 ? cacheInicial.userId : null);
  // Quando foi o último download da lista de notas (para não baixar tudo toda hora).
  const lastFetchRef = useRef<number>(0);

  // Atualizador único: garante que a "cópia rápida" (notesRef, usada por
  // fetchNotes/syncToSupabase pra decisões rápidas) e a tela oficial mudam
  // sempre no MESMO instante — nunca uma um pouquinho atrasada da outra.
  // Antes, várias funções (excluir, restaurar, editar, etc.) só atualizavam
  // a tela oficial e deixavam a cópia rápida pra um efeito separado
  // atualizar depois — isso abria uma brechinha de alguns milissegundos
  // onde, se algo rodasse bem nesse meio tempo (o app voltar pro primeiro
  // plano, um aviso do servidor chegando), essa checagem via a cópia
  // desatualizada, sem a mudança — e "resgatava" a nota de volta (fixar
  // desfazendo sozinho, nota excluída reaparecendo).
  const setNotesAndRef = useCallback((updater: Note[] | ((prev: Note[]) => Note[])) => {
    // O novo valor é calculado AGORA, a partir do notesRef (a "fonte da verdade"), e não
    // dentro do setNotes: o React só roda a função de dentro do setNotes mais tarde, e
    // quem lia o notesRef logo em seguida (como a atualização das notas) via a lista
    // antiga — o que fazia baixar o texto de todas as notas de novo.
    const prev = notesRef.current;
    const next = typeof updater === "function" ? (updater as (p: Note[]) => Note[])(prev) : updater;
    notesRef.current = next;
    setNotes(next);
  }, []);

  // Salva no aparelho sempre que as notas mudam. A linha do notesRef aqui
  // agora é só uma rede de segurança redundante — o setNotesAndRef acima já
  // mantém as duas cópias sincronizadas na hora, sem esperar esse efeito.
  useEffect(() => {
    // (o notesRef é mantido pelo setNotesAndRef; não é regravado aqui para não voltar a uma lista antiga)
    if (loading && notes.length === 0) return;
    // Ainda é a cópia inicial (nada mudou): não regrava, nem na chave de outra conta.
    if (notes === cacheInicial.notas || notes === hidratadoNotasRef.current) return;
    gravarCache(user?.id || "anon", notes);
    if (user?.id) {
      try { localStorage.setItem("ultimo_usuario_id", user.id); } catch {}
    }
  }, [notes, user, loading, cacheInicial, gravarCache]);


  // Sync unsynced notes to Supabase
  const syncToSupabase = useCallback(async (notesToSync: Note[], depth = 0) => {
    if (!user || syncingRef.current) return;
    let queue = notesToSync.filter((n) => !n.sincronizado);
    if (queue.length === 0) {
      setSyncStatus("synced");
      return;
    }

    syncingRef.current = true;
    setSyncStatus("syncing");

    let allOk = true;
    // Em rodadas: se a pessoa mexer numa nota (ex: fixar) enquanto o envio
    // está rodando, essa nota continua pendente e vai de novo na rodada
    // seguinte — antes, o envio antigo marcava a nota como "sincronizada"
    // mesmo tendo mandado a versão velha, e a fixação voltava sozinha.
    for (let round = 0; round < 4 && queue.length > 0; round++) {
    let again = false;
    for (const snap of queue) {
      // Na 1ª rodada usa a nota recebida (a "cópia rápida" ainda pode estar
      // um passo atrás quando o envio é chamado). Nas rodadas seguintes usa
      // sempre a versão MAIS ATUAL, e pula a que já foi sincronizada.
      let note = snap;
      if (round > 0) {
        const ref = notesRef.current.find((n) => n.id === snap.id);
        if (ref && ref.sincronizado) continue;
        note = ref ?? snap;
      }
      try {
        // Antes de mandar por cima, confere o que já está no servidor —
        // se outro aparelho (ex: o computador) já salvou uma versão MAIS
        // NOVA dessa mesma nota nesse meio tempo, não sobrescreve ela com
        // dados velhos daqui. Isso evita, por exemplo, fixar uma nota no
        // celular e uma sincronização atrasada do computador desfazer sem
        // querer, mandando por cima um estado antigo.
        // Nota que a pessoa já mandou excluir de vez não pode ser reenviada.
        if (deletedIdsRef.current.has(note.id) || loadPendingDeletes(user.id).includes(note.id)) continue;
        const { data: serverRow } = await (supabase.from("notes") as any)
          .select("updated_at")
          .eq("id", note.id)
          .maybeSingle();

        const serverTs = serverRow?.updated_at ? new Date(serverRow.updated_at).getTime() : null;
        const seenTs = serverSeenRef.current.get(note.id);
        // Mexeram na nota em outro lugar = o servidor tem uma data diferente da que
        // este aparelho conhecia. Se a data é a mesma que já conhecíamos, o servidor
        // não mudou: a diferença é só relógio atrasado, e a mudança de agora vale.
        const changedElsewhere = seenTs === undefined || serverTs !== seenTs;
        if (serverTs !== null && serverTs > note.updatedAt.getTime() && changedElsewhere) {
          // O servidor já tem algo mais novo — descarta o envio local dessa
          // nota específica (o próximo fetchNotes traz a versão certa do
          // servidor pra cá) em vez de apagar por cima.
          // Exceção: fixar/desafixar é uma escolha da pessoa — com o relógio do
          // celular alguns segundos atrasado em relação ao servidor, a nota
          // parecia "mais velha" e a fixação era jogada fora (a nota fixava e
          // depois voltava). Só os campos de fixação são enviados.
          const intent = pinIntentRef.current.get(note.id);
          if (intent) {
            const { error: pinErr } = await (supabase.from("notes") as any)
              .update({ is_pinned: intent.isPinned, pin_order: intent.isPinned ? intent.pinOrder : null })
              .eq("id", note.id);
            if (pinErr) throw pinErr;
            pinIntentRef.current.delete(note.id);
          }
          setNotesAndRef((prev) => prev.map((n) => (n.id === note.id ? { ...n, sincronizado: true } : n)));
          continue;
        }

        const payload = {
          id: note.id,
          user_id: user.id,
          title: note.title,
          content: note.content,
          images: note.images,
          color: note.color,
          font_family: note.fontFamily,
          font_size: note.fontSize,
          status: note.status,
          updated_at: note.updatedAt.toISOString(),
          is_pinned: note.isPinned,
          pin_order: note.isPinned ? note.pinOrder : null,
          // Campos que faltavam aqui: uma nota excluída, com lembrete definido
          // ou bloqueada ENQUANTO OFFLINE fica marcada como "sincronizado: false",
          // mas essa fila de reenvio (disparada ao voltar a internet) só mandava
          // título/conteúdo/cor — perdendo a exclusão/lembrete/bloqueio.
          reminder_date: note.reminderDate ?? null,
          reminder_time: note.reminderTime ?? null,
          reminder_sound: note.reminderSound ?? "classico",
          reminder_native_sound_uri: note.reminderNativeSoundUri ?? null,
          reminder_native_sound_name: note.reminderNativeSoundName ?? null,
          is_locked: note.isLocked,
          lock_salt: note.lockSalt ?? null,
          deleted_at: note.deletedAt ? note.deletedAt.toISOString() : null,
          sincronizado: true,
          // Só manda a data de criação quando a nota ainda não existe no
          // servidor (nota nova ou importada). Em nota que já existe, mandar de
          // novo trunca os microssegundos e o servidor achava que a nota
          // mudou — alterando a data de atualização a cada fixação.
          ...(serverRow ? {} : { created_at: note.createdAt.toISOString() }),
        };
        const { data: saved, error } = await (supabase.from("notes") as any)
          .upsert(payload, { onConflict: "id" })
          .select("updated_at");
        if (error) throw error;
        const novaData = Array.isArray(saved) ? saved[0]?.updated_at : saved?.updated_at;
        if (novaData) serverSeenRef.current.set(note.id, new Date(novaData).getTime());
        else serverSeenRef.current.delete(note.id);
        // Só marca como sincronizada se a nota NÃO mudou enquanto era enviada.
        const cur = notesRef.current.find((n) => n.id === note.id);
        if (deletedIdsRef.current.has(note.id)) {
          // A nota foi excluída de vez ENQUANTO era enviada (ex.: desafixou e
          // excluiu logo em seguida, com sinal ruim): o envio pode ter recriado
          // a nota no servidor depois do pedido de exclusão. Apaga de novo —
          // e, se falhar, o pedido fica na fila para quando a internet voltar.
          const pend = loadPendingDeletes(user.id);
          if (!pend.includes(note.id)) savePendingDeletes(user.id, [...pend, note.id]);
          try {
            const { error: delErr } = await supabase.from("notes").delete().eq("id", note.id);
            if (!delErr) savePendingDeletes(user.id, loadPendingDeletes(user.id).filter((x) => x !== note.id));
          } catch {}
        } else if (!cur || cur === note) {
          // O banco troca "atualizada em" pela hora dele ao salvar (trigger). Se a nota
          // daqui ficasse com a data antiga, a próxima atualização da lista acharia que
          // o servidor tem algo mais novo e baixaria de novo o texto (com as fotos) da
          // nota que acabou de ser enviada. Por isso guarda a data que o servidor gravou.
          const dataServidor = novaData ? new Date(novaData) : null;
          const dataValida = dataServidor && !isNaN(dataServidor.getTime()) ? dataServidor : null;
          setNotesAndRef((prev) => prev.map((n) => (
            n.id === note.id ? { ...n, sincronizado: true, ...(dataValida ? { updatedAt: dataValida } : {}) } : n
          )));
          pinIntentRef.current.delete(note.id);
        } else if (!cur.sincronizado) {
          again = true; // mudou durante o envio: fica pendente e vai de novo
        }
      } catch (err: any) {
        // Essa nota específica não sincronizou (ex: foto grande demais pro
        // limite do banco de uma vez) — mas NÃO pode travar a fila inteira:
        // as outras notas pendentes continuam tentando normalmente. Antes,
        // uma falha aqui interrompia tudo, deixando até notas sem problema
        // nenhum presas sem sincronizar até a pessoa forçar salvando de novo.
        allOk = false;
        setLastSyncError({
          title: note.title || "(sem título)",
          message: err?.message || String(err) || "Erro desconhecido",
        });
      }
    }
    queue = again ? notesRef.current.filter((n) => !n.sincronizado) : [];
    }

    if (allOk) setLastSyncError(null);
    setSyncStatus(allOk ? "synced" : "offline");
    syncingRef.current = false;

    // Se a pessoa mexeu em algo bem no fim do envio, manda de novo.
    if (allOk && depth < 3 && notesRef.current.some((n) => !n.sincronizado)) {
      await syncToSupabase(notesRef.current, depth + 1);
    }
  }, [user]);

  const pinningSuppressRef = useRef(false);
  // IDs de notas modificadas localmente — ignora eventos realtime para elas
  const selfModifiedRef = useRef<Map<string, number>>(new Map());
  // Janela global "quieta" após qualquer escrita local — bloqueia fetchNotes por N ms
  const lastLocalWriteRef = useRef<number>(0);
  const markSelfModified = useCallback((id: string, ttl = 8000) => {
    selfModifiedRef.current.set(id, Date.now() + ttl);
    lastLocalWriteRef.current = Date.now();
  }, []);
  const isSelfModified = useCallback((id: string | undefined) => {
    if (!id) return false;
    const exp = selfModifiedRef.current.get(id);
    if (!exp) return false;
    if (Date.now() > exp) {
      selfModifiedRef.current.delete(id);
      return false;
    }
    return true;
  }, []);
  const inQuietWindow = useCallback((ms = 3000) => {
    return Date.now() - lastLocalWriteRef.current < ms;
  }, []);


  // Tenta apagar no servidor tudo o que está na fila. O que falhar (sem
  // internet) continua na fila para a próxima tentativa.
  // Devolve os ids que estavam na fila, para quem acabou de baixar a lista do
  // servidor descartar essas notas (a lista foi baixada ANTES da exclusão).
  const flushPendingDeletes = useCallback(async (): Promise<string[]> => {
    if (!user) return [];
    const ids = loadPendingDeletes(user.id);
    if (ids.length === 0) return [];
    const restantes: string[] = [];
    const apagarUma = async (id: string) => {
      try {
        const { error } = await supabase.from("notes").delete().eq("id", id);
        if (error) restantes.push(id);
      } catch {
        restantes.push(id);
      }
    };
    // Em lotes de até 100: esvaziar a lixeira vira 1 requisição em vez de 1 por nota.
    // Se o lote falhar (ex.: um id inválido), tenta uma a uma para uma nota ruim
    // não travar as outras.
    for (let i = 0; i < ids.length; i += 100) {
      const lote = ids.slice(i, i + 100);
      if (!navigator.onLine) { restantes.push(...lote); continue; }
      if (lote.length > 1) {
        try {
          const { error } = await supabase.from("notes").delete().in("id", lote);
          if (!error) continue;
        } catch { /* cai para uma a uma */ }
      }
      for (const id of lote) await apagarUma(id);
    }
    savePendingDeletes(user.id, restantes);
    return ids;
  }, [user]);

  const fetchNotesInterno = useCallback(async () => {
    await hidratacaoRef.current; // espera a cópia do IndexedDB (se estiver sendo lida)
    // Sem usuário ainda: carrega o que houver salvo localmente (chave "anon"
    // ou de um usuário anterior) para não deixar a tela vazia/travada offline.
    if (!user) {
      if (notesRef.current.length === 0) {
        const anonNotes = loadLocal("anon");
        let ultimoUsuario: string | null = null;
        try { ultimoUsuario = localStorage.getItem("ultimo_usuario_id"); } catch { /* ignora */ }
        const fallback = anonNotes.length > 0 ? anonNotes : ultimoUsuario ? await lerCacheCompleto(ultimoUsuario) : loadAnyLocal();
        if (fallback.length > 0) {
          setNotesAndRef(fallback);
          setSyncStatus("offline");
        }
      } else {
        // A lista já nasceu preenchida com a cópia do celular: não precisa ler de novo.
        setSyncStatus("offline");
      }
      setLoading(false);
      return;
    }
    if (marcasAbertura.usuarioPronto === undefined) marcasAbertura.usuarioPronto = agoraMs();

    // A cópia inicial era de OUTRA conta? Descarta antes de usar qualquer coisa.
    if (cacheUserIdRef.current !== null) {
      const donoDoCache = cacheUserIdRef.current;
      cacheUserIdRef.current = null;
      if (donoDoCache !== user.id) {
        notesRef.current = [];
        setNotesAndRef([]);
      }
    }

    // Mescla qualquer nota criada antes da sessão ficar disponível ("anon")
    // com as notas já salvas para este usuário.
    const anonNotes = loadLocal("anon");
    // Só o cache DESTA conta (nunca o de outra conta, que mostrava notas erradas ao abrir).
    // Na primeira atualização do app reaproveita a cópia já lida na abertura (antes lia a
    // cópia de vários MB uma segunda vez).
    cacheInicialUsadaRef.current = true;
    // Se já há notas em memória (vieram da cópia ao abrir), elas SÃO a cópia: não lê o
    // aparelho de novo. Só lê (IndexedDB e, por último, armazenamento comum) quando a lista está vazia.
    const userLocalNotes = notesRef.current.length > 0 ? notesRef.current : await lerCacheCompleto(user.id);
    const savedLocalNotes = anonNotes.length > 0 ? mergeNotes(anonNotes, userLocalNotes) : userLocalNotes;

    const localNotes = savedLocalNotes.filter((n) => !lixeiraVencida(n));
    lastFetchRef.current = Date.now();
    if (anonNotes.length > 0) {
      try { localStorage.removeItem(getLocalKey("anon")); } catch {}
    }

    // Mostra o que já está salvo no aparelho JÁ, sem esperar a internet —
    // é isso que faz o app abrir na hora, com as notas todas visíveis. A
    // internet só entra depois, silenciosamente, pra conferir/atualizar.
    if (localNotes.length > 0) {
      if (assinaturaNotas(user.id, localNotes) !== assinaturaNotas(user.id, notesRef.current)) setNotesAndRef(localNotes);
      setLoading(false);
    }

    try {
      // Lista SEM as fotos (leve). As fotos entram só para notas novas/alteradas.
      const { data, error } = await (supabase.from("notes") as any)
        .select(COLUNAS_LISTA)
        .order("updated_at", { ascending: false });

      if (error) throw error;
      marcasAbertura.listasBaixadas++;

      // Notas que estão na lixeira há mais de 30 dias: pede para o servidor apagar
      // de vez e não deixa elas voltarem (era isso que fazia a lixeira piscar sem
      // você ter apagado nada: elas voltavam e eram apagadas de novo, em ciclo).
      const vencidasIds: string[] = ((data as any[]) || [])
        .filter((r) => lixeiraVencida({ deletedAt: r.deleted_at }))
        .map((r) => r.id);
      if (vencidasIds.length > 0) {
        vencidasIds.forEach((id) => deletedIdsRef.current.add(id));
        savePendingDeletes(user.id, [...loadPendingDeletes(user.id), ...vencidasIds]);
      }

      // Antes de mesclar: reenvia as exclusões pendentes e nunca deixa
      // voltar uma nota que a pessoa já apagou de vez.
      const apagadas = new Set(await flushPendingDeletes());
      const remoteBase = ((data as any[]) ? (data as any[]).map(mapRow) : []).filter((n) => !apagadas.has(n.id) && !lixeiraVencida(n));

      // Corpo e fotos: só baixa para notas que ainda não existem aqui ou que foram
      // alteradas em outro aparelho (versão do servidor mais nova que a daqui).
      // Nos outros casos a versão daqui é a que vale (ver mergeNotes), então
      // baixar o texto com as fotos de novo seria desperdício.
      const aqui = new Map<string, Note>();
      localNotes.forEach((n) => aqui.set(n.id, n));
      notesRef.current.forEach((n) => aqui.set(n.id, n));
      const precisamCorpo = remoteBase
        .filter((r) => {
          const l = aqui.get(r.id);
          return !l || (l.sincronizado && r.updatedAt.getTime() > l.updatedAt.getTime());
        })
        .map((r) => r.id);
      const corpoPorId = new Map<string, { content: string; images: string[] }>();
      const semCorpo = new Set<string>();
      for (let i = 0; i < precisamCorpo.length; i += 10) {
        const lote = precisamCorpo.slice(i, i + 10);
        try {
          const { data: corpos, error: corpoErr } = await (supabase.from("notes") as any).select("id, content").in("id", lote);
          if (corpoErr || !corpos) throw corpoErr || new Error("sem dados");
          (corpos as any[]).forEach((r) => {
            corpoPorId.set(r.id, { content: r.content ?? "", images: [] });
            marcasAbertura.corposBaixados++;
            marcasAbertura.corposKB += Math.round(String(r.content ?? "").length / 1024);
          });
        } catch {
          // Não conseguiu o corpo desse lote: deixa essas notas para a próxima
          // atualização, em vez de mostrar vazias e correr o risco de apagar o
          // conteúdo (e as fotos) do servidor num salvamento futuro.
          lote.forEach((id) => semCorpo.add(id));
        }
      }
      const remoteNotes = remoteBase
        .filter((n) => !semCorpo.has(n.id) && (!precisamCorpo.includes(n.id) || corpoPorId.has(n.id)))
        .map((n) => (corpoPorId.has(n.id) ? { ...n, content: corpoPorId.get(n.id)!.content, images: corpoPorId.get(n.id)!.images } : n));
      remoteNotes.forEach((n) => serverSeenRef.current.set(n.id, n.updatedAt.getTime()));

      // Mescla contra o estado ATUAL de verdade (via a forma funcional),
      // nunca contra a "localNotes" capturada lá em cima antes de esperar
      // a rede — essa espera pode levar alguns segundos, tempo de sobra
      // pra pessoa fixar/excluir uma nota enquanto isso. Se a gente
      // mesclasse contra aquela foto antiga, a mudança fresca da pessoa
      // seria apagada por cima assim que essa busca terminasse.
      let mergedResult: Note[] = localNotes;
      setNotesAndRef((prev) => {
        const novo = mergeNotes(prev, remoteNotes);
        // Nada mudou? Mantém a MESMA lista (sem redesenhar a tela nem regravar o cache).
        mergedResult = assinaturaNotas(user.id, novo) === assinaturaNotas(user.id, prev) ? prev : novo;
        return mergedResult;
      });
      gravarCache(user.id, mergedResult);
      if (marcasAbertura.servidorOk === undefined) marcasAbertura.servidorOk = agoraMs();

      // Sync any local-only notes
      const unsynced = mergedResult.filter((n) => !n.sincronizado);
      if (unsynced.length > 0) {
        syncToSupabase(mergedResult);
      } else {
        setSyncStatus("synced");
      }
    } catch {
      // Offline - mantém o que já estiver na tela (nunca apaga por cima
      // uma mudança mais nova feita enquanto essa tentativa de rede,
      // que falhou, ainda estava em andamento) — só usa a foto antiga
      // salva localmente se ainda não tiver nada na tela de jeito nenhum.
      setNotesAndRef((prev) => (prev.length > 0 ? prev : localNotes));
      if (localNotes.length > 0) gravarCache(user.id, localNotes);
      setSyncStatus("offline");
    }
    setLoading(false);
  }, [user, syncToSupabase, flushPendingDeletes, gravarCache, cacheInicial]);

  // Uma atualização por vez: se já há uma rodando para este usuário, as outras esperam e
  // só uma repetição leve acontece depois. Antes, na abertura rodavam 2 a 3 ao mesmo
  // tempo (cada mudança do objeto do usuário disparava outra) e cada uma baixava o
  // texto de TODAS as notas.
  const fetchInternoRef = useRef(fetchNotesInterno);
  fetchInternoRef.current = fetchNotesInterno;
  const userIdAtualRef = useRef<string | null>(null);
  userIdAtualRef.current = user?.id ?? null;
  const fetchEmCursoRef = useRef<{ uid: string | null; p: Promise<void> } | null>(null);
  const fetchPendenteRef = useRef(false);
  const fetchNotesRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const fetchNotes = useCallback((): Promise<void> => {
    const uid = userIdAtualRef.current;
    const atual = fetchEmCursoRef.current;
    if (atual && atual.uid === uid) {
      fetchPendenteRef.current = true; // pediram de novo durante a atualização: repete 1 vez no fim
      return atual.p;
    }
    const p: Promise<void> = fetchInternoRef.current()
      .catch(() => { /* erros já tratados dentro da atualização */ })
      .finally(() => {
        if (fetchEmCursoRef.current?.p === p) fetchEmCursoRef.current = null;
        if (fetchPendenteRef.current) {
          fetchPendenteRef.current = false;
          void fetchNotesRef.current();
        }
      });
    fetchEmCursoRef.current = { uid, p };
    return p;
  }, []);
  fetchNotesRef.current = fetchNotes;

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes, user?.id]);

  // Baixa de novo só se já passou tempo suficiente desde o último download.
  const fetchSePassouTempo = useCallback((minMs: number) => {
    if (Date.now() - lastFetchRef.current < minMs) return;
    fetchNotes();
  }, [fetchNotes]);

  // Realtime sync — atualiza automaticamente em todos os dispositivos
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("notes_realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notes",
          filter: `user_id=eq.${user.id}`,
        },
        (payload: any) => {
          const changedId = payload?.new?.id ?? payload?.old?.id;
          if (isSelfModified(changedId)) {
            console.log("[notes-realtime] ignorado (self-modified):", changedId);
            return;
          }
          if (inQuietWindow()) {
            console.log("[notes-realtime] ignorado (quiet window)");
            return;
          }
          if (pinningSuppressRef.current) return;
          fetchSePassouTempo(10000);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, fetchNotes, fetchSePassouTempo]);

  // Atualiza quando o app volta para primeiro plano
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchSePassouTempo(60000); // voltou ao app: atualiza, mas no máximo 1 vez por minuto
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [fetchSePassouTempo]);

  // Listen for online/offline
  useEffect(() => {
    const handleOnline = () => {
      setSyncStatus("syncing");
      // Re-fetch to merge remote changes, then push any pending local changes
      fetchNotes();
    };
    const handleOffline = () => setSyncStatus("offline");
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [fetchNotes]);

  // Rede de segurança: com o app aberto e visível, atualiza a lista de 10 em 10
  // minutos (as mudanças de outros aparelhos já chegam na hora pelo Realtime).
  // Antes baixava TODAS as notas a cada 30 segundos — era isso que estourava a
  // cota de dados do Supabase.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      if (navigator.onLine && !syncingRef.current && document.visibilityState === "visible") {
        fetchSePassouTempo(5 * 60 * 1000);
      }
    }, 10 * 60 * 1000);
    return () => clearInterval(id);
  }, [user, fetchSePassouTempo]);

  // Reenvio leve: a cada 1 minuto, se alguma nota ficou pendente (internet ruim),
  // tenta enviar de novo — sem baixar nada.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      if (navigator.onLine && !syncingRef.current && notesRef.current.some((n) => !n.sincronizado)) {
        syncToSupabase(notesRef.current);
      }
    }, 60000);
    return () => clearInterval(id);
  }, [user, syncToSupabase]);

  const addNote = useCallback(
    async (title: string, content: string, images: string[] = [], color?: string, fontFamily?: string, fontSize?: string, status: "rascunho" | "publicada" = "publicada") => {
      const noteColor = color || COLORS[Math.floor(Math.random() * COLORS.length)];
      const newId = crypto.randomUUID();
      const now = new Date();

      const note: Note = {
        id: newId,
        title,
        content,
        images,
        createdAt: now,
        updatedAt: now,
        color: noteColor,
        fontFamily: fontFamily || "default",
        fontSize: fontSize || "medium",
        status,
        sincronizado: false,
        isLocked: false,
        lockSalt: null,
        reminderDate: null,
        reminderTime: null,
        isPinned: false,
      };

      // Sempre cria a nota localmente primeiro, independente de internet/sessão.
      setNotesAndRef((prev) => [note, ...prev]);
      // O aviso em tempo real desta própria criação não precisa disparar uma atualização da lista.
      markSelfModified(newId, 15000);

      // Sem usuário autenticado ainda (ex: offline na primeira carga) — mantém
      // a nota local; ela será sincronizada quando a sessão/conexão voltar.
      if (!user) {
        setSyncStatus("offline");
        return note;
      }

      try {
        const { data } = await (supabase.from("notes") as any)
          .insert({
            id: newId,
            user_id: user.id,
            title,
            content,
            images,
            color: noteColor,
            font_family: fontFamily || "default",
            font_size: fontSize || "medium",
            status,
            is_pinned: false,
            sincronizado: true,
          })
          .select("created_at, updated_at") // só as datas: o texto e as fotos acabaram de subir daqui
          .single();

        if (data) {
          setNotesAndRef((prev) =>
            prev.map((n) => (n.id === newId ? { ...n, sincronizado: true, createdAt: new Date(data.created_at), updatedAt: new Date(data.updated_at) } : n))
          );
          setSyncStatus("synced");
        }
        return note;
      } catch {
        setSyncStatus("offline");
        return note;
      }
    },
    [user, markSelfModified]
  );

  // Soft delete — move to trash
  const deleteNote = useCallback(async (id: string) => {
    const now = new Date();
    markSelfModified(id, 30000);
    setNotesAndRef((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, deletedAt: now, updatedAt: now, sincronizado: false } : n);
      // Manda pela fila única de sincronização (já protegida contra
      // sobrescrever algo mais novo no servidor), em vez de uma chamada de
      // rede própria e independente daqui — menos "gente mexendo ao mesmo
      // tempo" reduz as chances de corrida com o realtime/outro aparelho.
      syncToSupabase(next);
      return next;
    });
  }, [markSelfModified, syncToSupabase]);

  // Restore from trash
  const restoreNote = useCallback(async (id: string) => {
    const now = new Date();
    markSelfModified(id, 30000);
    setNotesAndRef((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, deletedAt: null, updatedAt: now, sincronizado: false } : n);
      syncToSupabase(next);
      return next;
    });
  }, [markSelfModified, syncToSupabase]);

  // Permanent delete
  const permanentDeleteNote = useCallback(async (id: string) => {
    markSelfModified(id, 30000);
    deletedIdsRef.current.add(id);
    setNotesAndRef((prev) => prev.filter((n) => n.id !== id));
    if (!user) return;
    // Entra na fila ANTES de tentar: se a internet falhar, o pedido de
    // exclusão não se perde e é reenviado depois.
    savePendingDeletes(user.id, [...loadPendingDeletes(user.id), id]);
    await flushPendingDeletes();
  }, [markSelfModified, user, flushPendingDeletes]);

  // Empty trash
  const emptyTrash = useCallback(async () => {
    const trashIds = notes.filter((n) => n.deletedAt).map((n) => n.id);
    trashIds.forEach((id) => deletedIdsRef.current.add(id));
    setNotesAndRef((prev) => prev.filter((n) => !n.deletedAt));
    if (!user || trashIds.length === 0) return;
    savePendingDeletes(user.id, [...loadPendingDeletes(user.id), ...trashIds]);
    await flushPendingDeletes();
  }, [notes, user, flushPendingDeletes]);

  // Auto-delete notes older than 30 days in trash
  useEffect(() => {
    const now = Date.now();
    const expired = notes.filter((n) => {
      if (!n.deletedAt) return false;
      const deletedTime = n.deletedAt instanceof Date ? n.deletedAt.getTime() : new Date(n.deletedAt).getTime();
      return !isNaN(deletedTime) && now - deletedTime > 30 * 24 * 60 * 60 * 1000;
    });
    if (expired.length > 0) {
      expired.forEach((n) => permanentDeleteNote(n.id));
    }
  }, [notes, permanentDeleteNote]);

  const updateNote = useCallback(
    async (id: string, title: string, content: string, images?: string[], color?: string, fontFamily?: string, fontSize?: string, status?: "rascunho" | "publicada") => {
      const now = new Date();
      markSelfModified(id, 30000);
      // A nota é salva no aparelho e entra na fila de envio. Se não houver
      // internet (ou o sinal estiver ruim), ela continua marcada como "não
      // enviada" e é reenviada sozinha quando a conexão voltar. Antes, o envio
      // direto ignorava o erro de rede e marcava a nota como enviada mesmo sem
      // ter chegado ao servidor — a edição só existia neste aparelho.
      setNotesAndRef((prev) => {
        const next = prev.map((n) =>
          n.id === id
            ? {
                ...n,
                title,
                content,
                images: images ?? n.images,
                color: color ?? n.color,
                fontFamily: fontFamily ?? n.fontFamily,
                fontSize: fontSize ?? n.fontSize,
                status: status ?? n.status,
                updatedAt: now,
                sincronizado: false,
              }
            : n
        );
        syncToSupabase(next);
        return next;
      });
    },
    [markSelfModified, syncToSupabase]
  );

  // Set/remove reminder
  const setNoteReminder = useCallback(async (
    id: string,
    reminderDate: string | null,
    reminderTime: string | null,
    reminderSound: AlertSoundId = "classico",
    reminderNativeSoundUri: string | null = null,
    reminderNativeSoundName: string | null = null
  ) => {
    markSelfModified(id, 30000);
    setNotesAndRef((prev) => {
      const next = prev.map((n) => n.id === id ? { ...n, reminderDate, reminderTime, reminderSound, reminderNativeSoundUri, reminderNativeSoundName, updatedAt: new Date(), sincronizado: false } : n);
      syncToSupabase(next);
      return next;
    });
  }, [markSelfModified, syncToSupabase]);

  // Toggle pinned state for a note
  const togglePinNote = useCallback(async (id: string) => {
    if (!user) {
      setSyncStatus("offline");
      return;
    }

    const nowPin = new Date();
    let newPinned = false;
    let newPinOrder: number | null = null;

    // Usa sempre a forma "funcional" do setNotesAndRef — nunca lê a cópia
    // rápida direto pra depois escrever um valor pronto por cima. Assim, se
    // outra mudança (excluir, editar) tiver acontecido quase ao mesmo tempo
    // e ainda não tiver "assentado", essa mudança nunca é apagada por cima
    // sem querer — o React sempre aplica em cima do estado mais atual de
    // verdade, nunca de uma foto antiga.
    setNotesAndRef((prev) => {
      const note = prev.find((n) => n.id === id);
      if (!note) return prev;
      newPinned = !note.isPinned;
      newPinOrder = newPinned
        ? Math.max(-1, ...prev.filter((n) => n.isPinned && !n.deletedAt).map((n) => n.pinOrder ?? 0)) + 1
        : null;
      const next = prev.map((n) => (
        n.id === id ? { ...n, isPinned: newPinned, pinOrder: newPinOrder, updatedAt: nowPin, sincronizado: false } : n
      ));
      // Ignora eventos realtime desta nota enquanto a mudança propaga.
      markSelfModified(id, 30000);
      pinIntentRef.current.set(id, { isPinned: newPinned, pinOrder: newPinOrder });
      pinningSuppressRef.current = true;
      setTimeout(() => { pinningSuppressRef.current = false; }, 30000);
      syncToSupabase(next);
      return next;
    });
  }, [user, markSelfModified, syncToSupabase]);

  // Reordena as notas fixadas (▲ sobe, ▼ desce). Também normaliza o pinOrder
  // de todas as fixadas para números sequenciais, corrigindo notas antigas
  // que ainda não tinham essa coluna preenchida.
  const reorderPinnedNote = useCallback(async (id: string, direction: -1 | 1) => {
    setNotesAndRef((prev) => {
      const pinned = prev
        .filter((n) => n.isPinned && !n.deletedAt)
        .sort((a, b) => {
          const ao = a.pinOrder ?? Infinity, bo = b.pinOrder ?? Infinity;
          if (ao !== bo) return ao - bo;
          return b.updatedAt.getTime() - a.updatedAt.getTime();
        });

      const idx = pinned.findIndex((n) => n.id === id);
      const targetIdx = idx + direction;
      if (idx === -1 || targetIdx < 0 || targetIdx >= pinned.length) return prev;

      const reordered = [...pinned];
      [reordered[idx], reordered[targetIdx]] = [reordered[targetIdx], reordered[idx]];
      const updates = reordered.map((n, i) => ({ id: n.id, pinOrder: i }));
      updates.forEach((u) => {
        markSelfModified(u.id, 30000);
        pinIntentRef.current.set(u.id, { isPinned: true, pinOrder: u.pinOrder });
      });

      const next = prev.map((n) => {
        const u = updates.find((x) => x.id === n.id);
        return u ? { ...n, pinOrder: u.pinOrder, sincronizado: false } : n;
      });
      syncToSupabase(next);
      return next;
    });
  }, [markSelfModified, syncToSupabase]);

  const lockNoteWithPin = useCallback(async (id: string, pin: string): Promise<boolean> => {
    const note = notes.find((n) => n.id === id);
    if (!note) return false;
    if (isEncrypted(note.content)) return true; // already locked
    const payload: LockPayload = { title: note.title, content: note.content, images: note.images };
    const { cipher, salt } = await encryptNote(pin, payload);
    const now = new Date();
    setNotesAndRef((prev) => {
      const next = prev.map((n) => n.id === id
        ? { ...n, title: "🔒", content: cipher, images: [], isLocked: true, lockSalt: salt, updatedAt: now, sincronizado: false }
        : n);
      syncToSupabase(next);
      return next;
    });
    return true;
  }, [notes, syncToSupabase]);

  // Verify a PIN against an encrypted note (does not persist or unlock).
  const verifyNotePin = useCallback(async (id: string, pin: string): Promise<LockPayload | null> => {
    const note = notes.find((n) => n.id === id);
    if (!note || !note.lockSalt || !isEncrypted(note.content)) return null;
    return decryptNote(pin, note.content, note.lockSalt);
  }, [notes]);

  // Permanently unlock: decrypt with PIN, restore plaintext, clear lock fields.
  const unlockNoteWithPin = useCallback(async (id: string, pin: string): Promise<boolean> => {
    const note = notes.find((n) => n.id === id);
    if (!note || !note.lockSalt) return false;
    const payload = await decryptNote(pin, note.content, note.lockSalt);
    if (!payload) return false;
    const now = new Date();
    setNotesAndRef((prev) => {
      const next = prev.map((n) => n.id === id
        ? { ...n, title: payload.title, content: payload.content, images: payload.images, isLocked: false, lockSalt: null, updatedAt: now, sincronizado: false }
        : n);
      syncToSupabase(next);
      return next;
    });
    return true;
  }, [notes, syncToSupabase]);

  const draftCount = notes.filter((n) => n.status === "rascunho" && !n.deletedAt).length;
  // Notas que só existem no aparelho por enquanto — se os dados do app forem
  // apagados (ou o app desinstalado) antes da internet voltar e sincronizar,
  // essas são as que se perderiam. Conta tudo (inclusive lixeira), porque uma
  // exclusão pendente de sincronizar também é uma mudança não salva ainda.
  const unsyncedCount = notes.filter((n) => !n.sincronizado).length;
  const activeNotes = notes
    .filter((n) => !n.deletedAt)
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (a.isPinned && b.isPinned) {
        const ao = a.pinOrder ?? Infinity, bo = b.pinOrder ?? Infinity;
        if (ao !== bo) return ao - bo;
      }
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });
  const trashedNotes = notes.filter((n) => !!n.deletedAt && !lixeiraVencida(n));

  // Build backup payload (shared by manual export and auto-backup)
  const buildBackupData = useCallback(() => {
    const data = notes.map((n) => ({
      id: n.id,
      titulo: n.title,
      conteudo: n.content,
      cor: n.color,
      status: n.status,
      criado_em: n.createdAt.toISOString(),
      atualizado_em: n.updatedAt.toISOString(),
      images: n.images,
      fontFamily: n.fontFamily,
      fontSize: n.fontSize,
      // v2 — o que o backup antigo deixava de fora: lembretes, trancadas
      // (PIN), lixeira e fixadas.
      lembrete_data: n.reminderDate ?? null,
      lembrete_hora: n.reminderTime ?? null,
      lembrete_som: n.reminderSound ?? "classico",
      lembrete_som_nativo_uri: n.reminderNativeSoundUri ?? null,
      lembrete_som_nativo_nome: n.reminderNativeSoundName ?? null,
      trancada: n.isLocked,
      sal_tranca: n.lockSalt ?? null,
      excluida_em: n.deletedAt ? n.deletedAt.toISOString() : null,
      fixada: n.isPinned,
      ordem_fixada: n.pinOrder ?? null,
    }));
    return { app: "minhas_notas", version: 2, exportado_em: new Date().toISOString(), notas: data };
  }, [notes]);

  // Export backup (manual download)
  const exportBackup = useCallback(() => {
    const payload = buildBackupData();
    const dateStr = new Date().toISOString().slice(0, 10);
    // No app Android abre o menu de compartilhar (Drive, WhatsApp, e-mail);
    // no navegador baixa o arquivo.
    void shareOrSaveTextFile(`minhas_notas_backup_completo_${dateStr}.json`, JSON.stringify(payload, null, 2));
    localStorage.setItem("ultimo_backup", new Date().toISOString());
    return true;
  }, [buildBackupData]);

  // Auto backup: silently saves the latest backup snapshot to localStorage
  // whenever notes are synced with Supabase. No download/dialog is triggered.
  const saveAutoBackup = useCallback(() => {
    if (notes.length === 0) return;
    try {
      const payload = buildBackupData();
      localStorage.setItem(
        getLocalKey(user?.id || "anon") + "_auto_backup",
        JSON.stringify(payload)
      );
      localStorage.setItem("ultimo_backup_automatico", new Date().toISOString());
    } catch {}
  }, [buildBackupData, notes, user]);

  // Whenever sync completes successfully, refresh the automatic backup snapshot
  useEffect(() => {
    if (syncStatus === "synced") {
      saveAutoBackup();
    }
  }, [syncStatus, saveAutoBackup]);

  // Import backup
  const importBackup = useCallback(async (file: File): Promise<number> => {
    const text = await file.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Arquivo inválido");
    }
    if (!parsed.app || parsed.app !== "minhas_notas" || !Array.isArray(parsed.notas)) {
      throw new Error("Formato de backup não reconhecido");
    }

    // Importa PRESERVANDO tudo (id, datas originais, fixadas, trancadas,
    // lembretes, lixeira). Se a nota já existe aqui, só troca quando a do
    // backup for mais nova. Backups antigos (v1) também funcionam: o que não
    // existir neles fica com o valor padrão.
    const toDate = (v: any, fallback: Date) => {
      const d = v ? new Date(v) : null;
      return d && !isNaN(d.getTime()) ? d : fallback;
    };
    const now = new Date();
    const base = notesRef.current;
    const byId = new Map(base.map((n) => [n.id, n]));
    const incoming = new Map<string, Note>();

    for (const item of parsed.notas) {
      if (!item || typeof item !== "object") continue;
      const id = typeof item.id === "string" && item.id ? item.id : crypto.randomUUID();
      const updatedAt = toDate(item.atualizado_em, now);
      const existing = byId.get(id);
      // Só pula se a nota que já está aqui for MAIS NOVA que a do backup. Com a
      // mesma data, o backup vence e é enviado ao banco: a cópia guardada no
      // aparelho vem sem fotos e pode nem ter chegado à conta atual (ex.: depois
      // de trocar de banco, o app mostra as notas do aparelho sem elas estarem
      // no servidor).
      if (existing && existing.updatedAt.getTime() > updatedAt.getTime()) continue;
      const already = incoming.get(id);
      if (already && already.updatedAt.getTime() >= updatedAt.getTime()) continue;
      incoming.set(id, {
        id,
        title: typeof item.titulo === "string" ? item.titulo : "",
        content: typeof item.conteudo === "string" ? item.conteudo : "",
        images: Array.isArray(item.images) ? item.images : [],
        createdAt: toDate(item.criado_em, updatedAt),
        updatedAt,
        color: item.cor || COLORS[0],
        fontFamily: item.fontFamily || "default",
        fontSize: item.fontSize || "medium",
        status: item.status === "rascunho" ? "rascunho" : "publicada",
        sincronizado: false,
        reminderDate: item.lembrete_data ?? null,
        reminderTime: item.lembrete_hora ?? null,
        reminderSound: (item.lembrete_som || "classico") as AlertSoundId,
        reminderNativeSoundUri: item.lembrete_som_nativo_uri ?? null,
        reminderNativeSoundName: item.lembrete_som_nativo_nome ?? null,
        isLocked: !!item.trancada,
        lockSalt: item.sal_tranca ?? null,
        deletedAt: item.excluida_em ? toDate(item.excluida_em, now) : null,
        isPinned: !!item.fixada,
        pinOrder: item.fixada ? (item.ordem_fixada ?? null) : null,
      });
    }

    const imported = Array.from(incoming.values());
    // Compromissos da Agenda que vêm junto no backup (campo "agenda").
    // Só entram os que ainda não existem aqui: nunca sobrescreve o que já
    // foi editado nesta conta.
    const importarAgenda = async () => {
      const lista = Array.isArray(parsed.agenda) ? parsed.agenda : [];
      if (!user || lista.length === 0) return;
      try {
        const rows = lista
          .filter((a: any) => a && a.id && a.title && a.date)
          .map((a: any) => ({
            id: a.id,
            user_id: user.id,
            title: a.title,
            date: String(a.date).slice(0, 10),
            time: a.time || "09:00",
            description: a.description || "",
            alert_sound: a.alert_sound || "classico",
            alert_native_sound_uri: a.alert_native_sound_uri ?? null,
            alert_native_sound_name: a.alert_native_sound_name ?? null,
            deleted_at: a.deleted_at ?? null,
            ...(a.created_at ? { created_at: a.created_at } : {}),
            ...(a.updated_at ? { updated_at: a.updated_at } : {}),
          }));
        let novos = 0;
        for (let i = 0; i < rows.length; i += 100) {
          const { data, error } = await (supabase.from("appointments") as any)
            .upsert(rows.slice(i, i + 100), { onConflict: "id", ignoreDuplicates: true })
            .select("id");
          if (error) throw error;
          novos += data?.length ?? 0;
        }
        window.dispatchEvent(new Event("agenda-importada"));
        toast({ title: novos > 0 ? `Agenda: ${novos} compromissos importados` : "Agenda: nenhum compromisso novo (já estavam aqui)" });
      } catch (err: any) {
        toast({ title: "A Agenda não foi importada", description: err?.message || String(err) });
      }
    };

    if (imported.length === 0) {
      await importarAgenda();
      return 0;
    }

    // Nota que está sendo restaurada não pode continuar marcada como excluída.
    imported.forEach((n) => deletedIdsRef.current.delete(n.id));
    if (user) savePendingDeletes(user.id, loadPendingDeletes(user.id).filter((id) => !incoming.has(id)));
    // Evita que o aviso em tempo real dispare uma busca a cada nota enviada.
    imported.forEach((n) => markSelfModified(n.id, 120000));
    const merged = [...imported, ...base.filter((n) => !incoming.has(n.id))];
    setNotesAndRef(merged);

    // Se já tem uma sincronização rodando, espera ela terminar antes de enviar.
    for (let i = 0; i < 30 && syncingRef.current; i++) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (user) await syncToSupabase(merged);
    await importarAgenda();
    return imported.length;
  }, [user, markSelfModified, setNotesAndRef, syncToSupabase]);

  // Check if backup reminder needed (weekly) - considers both manual and automatic backups
  const shouldRemindBackup = useCallback(() => {
    const lastManual = localStorage.getItem("ultimo_backup");
    const lastAuto = localStorage.getItem("ultimo_backup_automatico");
    const lastTimestamps = [lastManual, lastAuto].filter(Boolean) as string[];
    if (lastTimestamps.length === 0) return notes.length > 0;
    const mostRecent = Math.max(...lastTimestamps.map((t) => new Date(t).getTime()));
    const diff = Date.now() - mostRecent;
    return diff > 7 * 24 * 60 * 60 * 1000 && notes.length > 0;
  }, [notes]);

  // Reminder alert system
  const [reminderAlert, setReminderAlert] = useState<SnoozeAlertData | null>(null);
  const snoozedRemindersRef = useRef<Map<string, number>>(new Map());

  const dismissReminderAlert = useCallback((id: string) => {
    setReminderAlert((current) => {
      // Só marca como "definitivamente dispensado" se for o alerta de lembrete vencido.
      // Alertas "próximos" já foram marcados em reminder_upcoming_fired_ids ao disparar,
      // e não devem impedir o alerta de "vencido" mais tarde.
      if (current && current.id === id && current.type === "reminder") {
        try {
          const key = "reminder_fired_ids";
          const fired = JSON.parse(localStorage.getItem(key) || "[]") as string[];
          if (!fired.includes(id)) {
            fired.push(id);
            localStorage.setItem(key, JSON.stringify(fired));
          }
        } catch {}
      }
      return null;
    });
  }, []);

  const snoozeReminderAlert = useCallback((id: string, minutes: number) => {
    setReminderAlert(null);
    snoozedRemindersRef.current.set(id, Date.now() + minutes * 60 * 1000);
  }, []);

  useEffect(() => {
    // Antes usava sessionStorage aqui — isso apagava a lista de alertas já
    // vistos toda vez que o app era fechado de verdade, fazendo um lembrete
    // já dispensado voltar a aparecer ao reabrir. Trocado para localStorage,
    // que persiste entre aberturas do app.
    const firedKey = "reminder_fired_ids";
    const upcomingFiredKey = "reminder_upcoming_fired_ids";
    const UPCOMING_WINDOW_MS = 15 * 60 * 1000; // avisa até 15 min antes do horário

    const getFired = (key: string): string[] => {
      try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
    };
    const markFired = (key: string, id: string) => {
      try {
        const fired = getFired(key);
        if (!fired.includes(id)) {
          fired.push(id);
          localStorage.setItem(key, JSON.stringify(fired));
        }
      } catch {}
    };

    const checkReminders = () => {
      if (reminderAlert) return;
      const now = Date.now();
      const fired = getFired(firedKey);
      const upcomingFired = getFired(upcomingFiredKey);

      for (const note of notes) {
        if (!note.reminderDate || !note.reminderTime) continue;

        const snoozeUntil = snoozedRemindersRef.current.get(note.id);
        if (snoozeUntil && now < snoozeUntil) continue;

        const reminderTime = new Date(`${note.reminderDate}T${note.reminderTime}:00`).getTime();
        const diff = now - reminderTime; // > 0 => já passou; < 0 => ainda vai chegar

        // Já passou (até 24h atrás) — alerta de lembrete vencido
        if (!fired.includes(note.id) && diff >= 0 && diff < 24 * 60 * 60 * 1000) {
          snoozedRemindersRef.current.delete(note.id);
          setReminderAlert({
            id: note.id,
            title: note.title || "Nota sem título",
            time: note.reminderTime,
            type: "reminder",
            soundId: note.reminderSound,
          });
          return;
        }

        // Está próximo (até 15 min antes) — alerta de "lembrete em breve"
        if (!upcomingFired.includes(note.id) && diff < 0 && diff > -UPCOMING_WINDOW_MS) {
          markFired(upcomingFiredKey, note.id);
          setReminderAlert({
            id: note.id,
            title: note.title || "Nota sem título",
            time: note.reminderTime,
            type: "reminder_upcoming",
            soundId: note.reminderSound,
          });
          return;
        }
      }
    };
    checkReminders();
    const interval = setInterval(checkReminders, 15000);
    return () => clearInterval(interval);
  }, [notes, reminderAlert]);

  return { notes: activeNotes, trashedNotes, addNote, deleteNote, restoreNote, permanentDeleteNote, emptyTrash, updateNote, setNoteReminder, togglePinNote, reorderPinnedNote, lockNoteWithPin, unlockNoteWithPin, verifyNotePin, loading, syncStatus, unsyncedCount, lastSyncError, draftCount, exportBackup, importBackup, shouldRemindBackup, reminderAlert, dismissReminderAlert, snoozeReminderAlert, refreshNotes: fetchNotes };
}
