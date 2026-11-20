import { useState, useRef, useEffect, useCallback, lazy, Suspense } from "react";
import { NoteCard } from "./NoteCard";
import { NoteEditor } from "./NoteEditor";
import { ReminderModal } from "./ReminderModal";
import { LockNoteModal } from "./LockNoteModal";
import { TrashView } from "./TrashView";
import { Note, SyncStatus } from "@/hooks/useNotes";
import { Search, Mic, MicOff, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
// Os relatórios são pesados e só aparecem quando você os abre: carregam sob demanda
// (e são pré-carregados em segundo plano uns segundos depois da abertura).
const RelatorioTurno = lazy(() => import("./RelatorioTurno").then((m) => ({ default: m.RelatorioTurno })));
const RelatorioRebobinadeira = lazy(() => import("./RelatorioRebobinadeira").then((m) => ({ default: m.RelatorioRebobinadeira })));
import type { AlertSoundId } from "@/lib/alertSound";

export { getFontClass, getSizeClass } from "./NoteEditor";

interface NotesViewProps {
  notes: Note[];
  carregando?: boolean;
  onAdd: (title: string, content: string, images?: string[], color?: string, fontFamily?: string, fontSize?: string, status?: "rascunho" | "publicada") => void;
  onDelete: (id: string) => void;
  onUpdate: (id: string, title: string, content: string, images?: string[], color?: string, fontFamily?: string, fontSize?: string, status?: "rascunho" | "publicada") => void;
  onSetReminder: (id: string, date: string | null, time: string | null, sound?: AlertSoundId, nativeSoundUri?: string | null, nativeSoundName?: string | null) => void;
  onTogglePin: (id: string) => void;
  onReorderPin?: (id: string, direction: -1 | 1) => void;
  onLockNote: (id: string, pin: string) => Promise<boolean>;
  onUnlockNote: (id: string, pin: string) => Promise<boolean>;
  onVerifyPin: (id: string, pin: string) => Promise<unknown | null>;
  onAddAppointment?: (title: string, date: Date, time: string, description: string, alertSound: AlertSoundId, nativeSoundUri?: string | null, nativeSoundName?: string | null) => void;
  onRefresh?: () => void;
  syncStatus: SyncStatus;
  draftCount: number;
  exportBackup: () => boolean;
  importBackup: (file: File) => Promise<number>;
  shouldRemindBackup: () => boolean;
  trashedNotes: Note[];
  onRestoreNote: (id: string) => void;
  onPermanentDeleteNote: (id: string) => void;
  onEmptyTrash: () => void;
}

export function NotesView({ notes, carregando, onAdd, onDelete, onUpdate, onSetReminder, onTogglePin, onReorderPin, onLockNote, onUnlockNote, onVerifyPin, onAddAppointment, onRefresh, syncStatus, draftCount, exportBackup, importBackup, shouldRemindBackup, trashedNotes, onRestoreNote, onPermanentDeleteNote, onEmptyTrash }: NotesViewProps) {
  const [search, setSearch] = useState("");
  const [showOnlyDrafts, setShowOnlyDrafts] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [showRelatorio, setShowRelatorio] = useState(false);
  // Pré-carrega os relatórios em segundo plano, sem atrapalhar a abertura.
  useEffect(() => {
    const t = setTimeout(() => { import("./RelatorioTurno"); import("./RelatorioRebobinadeira"); }, 3000);
    return () => clearTimeout(t);
  }, []);
  const [relatorioInitialState, setRelatorioInitialState] = useState<any>(null);
  const [relatorioNovo, setRelatorioNovo] = useState(false);
  const [showRebobinadeira, setShowRebobinadeira] = useState(false);
  const [rebobInitialState, setRebobInitialState] = useState<any>(null);
  const [rebobNovo, setRebobNovo] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmDeleteTitle, setConfirmDeleteTitle] = useState("");

  const [editorReadOnly, setEditorReadOnly] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [reminderNote, setReminderNote] = useState<Note | null>(null);
  const [lockNote, setLockNote] = useState<Note | null>(null);
  const [lockMode, setLockMode] = useState<"set" | "unlock" | "manage">("set");
  const [pendingUnlockNote, setPendingUnlockNote] = useState<Note | null>(null);

  const [fontSize, setFontSize] = useState<"sm" | "md" | "lg" | "xl">(() => {
    return (localStorage.getItem("notes_font_size") as "sm" | "md" | "lg" | "xl") || "md";
  });

  const changeFontSize = (size: "sm" | "md" | "lg" | "xl") => {
    setFontSize(size);
    localStorage.setItem("notes_font_size", size);
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Comandos vindos do menu ••• do topo da página (Index.tsx)
  useEffect(() => {
    // Menu •••: abre um relatório de Turno NOVO (turno e horário automáticos), sem reaproveitar rascunho antigo
    const onRelatorio = () => { setRelatorioInitialState(null); setRelatorioNovo(true); setShowRelatorio(true); };
    const onTrash = () => setShowTrash(true);
    const onFont = (e: Event) => changeFontSize((e as CustomEvent).detail);
    window.addEventListener("notes-menu:relatorio", onRelatorio);
    window.addEventListener("notes-menu:trash", onTrash);
    window.addEventListener("notes-menu:font-size", onFont as EventListener);
    return () => {
      window.removeEventListener("notes-menu:relatorio", onRelatorio);
      window.removeEventListener("notes-menu:trash", onTrash);
      window.removeEventListener("notes-menu:font-size", onFont as EventListener);
    };
  }, []);

  // Conteúdo compartilhado de outro app (WhatsApp, Galeria, navegador, etc.)
  // — vem gravado no sessionStorage pelo ShareReceiver.tsx (compartilhamento
  // pelo navegador/PWA) ou direto pelo MainActivity.java (app instalado no
  // Android). Assim que aparecer, cria uma nota nova automaticamente com
  // esse título/texto/foto.
  // Reforço extra (além do lado nativo em MainActivity.java) contra o
  // mesmo compartilhamento virar duas notas: guarda uma "assinatura" do
  // último conteúdo compartilhado processado e ignora uma repetição
  // idêntica que chegue nos segundos seguintes.
  const lastSharedRef = useRef<{ signature: string; at: number } | null>(null);

  useEffect(() => {
    const consumeSharedNote = () => {
      const raw = sessionStorage.getItem("shared_note_data");
      if (!raw) return;
      sessionStorage.removeItem("shared_note_data");
      try {
        const data = JSON.parse(raw) as { title?: string; content?: string; image?: string | null };
        const title = data.title || "";
        const text = data.content || "";
        if (!title && !text && !data.image) return;

        const signature = `${title}|${text}|${data.image || ""}`;
        const now = Date.now();
        if (lastSharedRef.current && lastSharedRef.current.signature === signature && now - lastSharedRef.current.at < 4000) {
          return; // mesmo compartilhamento chegou de novo em seguida — ignora
        }
        lastSharedRef.current = { signature, at: now };

        // As fotos de uma nota não ficam soltas num campo à parte — elas
        // vivem DENTRO do texto da nota, como um "bloco" de imagem (é assim
        // que o NoteEditor lê e mostra o conteúdo). Por isso montamos o
        // conteúdo nesse formato de blocos, em vez de só texto puro.
        const blocks: Array<{ type: string; content?: string; url?: string }> = [];
        if (text) blocks.push({ type: "text", content: text });
        if (data.image) blocks.push({ type: "image", url: data.image });
        const content = JSON.stringify(blocks);

        onAdd(title, content, data.image ? [data.image] : []);
        toast({ title: "📥 Nota criada a partir do compartilhamento" });
      } catch (e) {
        console.error("Erro ao ler conteúdo compartilhado:", e);
      }
    };

    // Já pode ter chegado antes desta tela montar (abertura a frio do app)
    consumeSharedNote();
    // E pode chegar enquanto o app já está aberto (app em segundo plano)
    window.addEventListener("shared-note-ready", consumeSharedNote);
    return () => window.removeEventListener("shared-note-ready", consumeSharedNote);
  }, [onAdd]);


  const fontSizeMap = { sm: 12, md: 14, lg: 18, xl: 22 };

  const handleVoiceResult = useCallback((text: string) => {
    setSearch((prev) => (prev + " " + text).trim());
  }, []);
  const { isListening, isSupported: voiceSupported, toggle: toggleVoice } = useSpeechRecognition(handleVoiceResult);

  useEffect(() => {
    if (draftCount === 0 && showOnlyDrafts) setShowOnlyDrafts(false);
  }, [draftCount, showOnlyDrafts]);

  const filtered = notes
    .filter((n) => !showOnlyDrafts || n.status === "rascunho")
    .filter(
      (n) =>
        n.title.toLowerCase().includes(search.toLowerCase()) ||
        n.content.toLowerCase().includes(search.toLowerCase())
    );

  const openNew = () => { setEditingNote(null); setEditorReadOnly(false); setDialogOpen(true); };

  const openEdit = (note: Note) => {
    // Com uma nota aberta no editor, a lista de trás não pode abrir outra nota por cima
    // (acontecia ao tocar na lista com o celular deitado ou no computador, onde o editor
    // é uma caixa menor que a tela). Feche a nota atual primeiro.
    if (dialogOpen) return;
    if (note.isLocked) {
      setPendingUnlockNote(note);
      setLockNote(note);
      setLockMode("unlock");
      return;
    }

    // Detecta se a nota é um Relatório de Turno / Tombador / Embaladeira
    const turnoMatch = note.content.match(/<!--relatorio-turno-state:([\s\S]*?)-->/);
    if (turnoMatch) {
      try {
        const state = JSON.parse(turnoMatch[1]);
        setRelatorioInitialState(state);
        setRelatorioNovo(false);
        setShowRelatorio(true);
        return;
      } catch (e) {
        console.error("Erro ao ler estado do Relatório de Turno:", e);
      }
    }

    // Detecta se a nota é um Relatório da Rebobinadeira
    const rebobMatch = note.content.match(/<!--relatorio-rebobinadeira-state:([\s\S]*?)-->/);
    if (rebobMatch) {
      try {
        const state = JSON.parse(rebobMatch[1]);
        setRebobInitialState(state);
        setRebobNovo(false);
        setShowRebobinadeira(true);
        return;
      } catch (e) {
        console.error("Erro ao ler estado do Relatório da Rebobinadeira:", e);
      }
    }

    setEditorReadOnly(true);
    setEditingNote(note);
    setDialogOpen(true);
  };

  const handleSave = (title: string, content: string, images: string[], color: string, fontFamily: string, fontSize: string, status: "rascunho" | "publicada") => {
    if (editingNote) {
      onUpdate(editingNote.id, title, content, images, color, fontFamily, fontSize, status);
    } else {
      onAdd(title, content, images, color, fontFamily, fontSize, status);
    }
  };

  const handleBellClick = (note: Note) => setReminderNote(note);

  const handlePinClick = (note: Note) => {
    onTogglePin(note.id);
    toast({ title: note.isPinned ? "📌 Nota desafixada" : "📌 Nota fixada" });
  };

  const handleReminderSave = (date: string, time: string, sound: AlertSoundId, nativeSoundUri: string | null, nativeSoundName: string | null) => {
    if (!reminderNote) return;
    onSetReminder(reminderNote.id, date, time, sound, nativeSoundUri, nativeSoundName);
    if (onAddAppointment) {
      onAddAppointment(reminderNote.title || "Lembrete", new Date(date + "T00:00:00"), time, `Lembrete da nota: ${reminderNote.title}`, sound, nativeSoundUri, nativeSoundName);
    }
    toast({ title: "🔔 Lembrete agendado!", description: `${date} às ${time}` });
  };

  const handleReminderRemove = () => {
    if (!reminderNote) return;
    onSetReminder(reminderNote.id, null, null);
    toast({ title: "Lembrete removido" });
  };

  const handleLockClick = (note: Note) => {
    setLockNote(note);
    setLockMode(note.isLocked ? "manage" : "set");
  };

  const handleSetPin = async (pin: string) => {
    if (!lockNote) return;
    const ok = await onLockNote(lockNote.id, pin);
    if (ok) toast({ title: "🔒 Nota protegida!", description: "Conteúdo criptografado neste dispositivo" });
  };

  const handleUnlockAttempt = async (pin: string): Promise<boolean> => {
    if (!lockNote) return false;
    const payload = await onVerifyPin(lockNote.id, pin);
    if (!payload) return false;
    if (pendingUnlockNote?.id === lockNote.id) {
      setEditingNote({ ...pendingUnlockNote, ...(payload as any), isLocked: true });
      setEditorReadOnly(true);
      setDialogOpen(true);
      setPendingUnlockNote(null);
    }
    return true;
  };

  const handleRemoveLock = async () => {
    if (!lockNote) return;
  };

  const handleManageRemove = async (pin: string): Promise<boolean> => {
    if (!lockNote) return false;
    const ok = await onUnlockNote(lockNote.id, pin);
    if (ok) toast({ title: "🔓 Proteção removida" });
    return ok;
  };

  const handleForceReset = async () => {
    if (!lockNote) return;
    onUpdate(lockNote.id, lockNote.title, "", [], lockNote.color, "default", "medium", "publicada");
    await onUnlockNote(lockNote.id, "000000").catch(() => {});
    toast({ title: "🔓 Proteção removida", description: "Conteúdo apagado e nota desbloqueada." });
    setLockNote(null);
    setPendingUnlockNote(null);
  };

  const handleDeleteWithConfirm = (id: string) => {
    const note = notes.find((n) => n.id === id);
    setConfirmDeleteTitle(note?.title || "Sem título");
    setConfirmDeleteId(id);
  };

  const confirmDelete = () => {
    if (confirmDeleteId) {
      onDelete(confirmDeleteId);
      toast({ title: "✅ Nota movida para a lixeira" });
      setConfirmDeleteId(null);
    }
  };

  if (showTrash) {
    return (
      <TrashView
        type="notes"
        trashedNotes={trashedNotes}
        onRestoreNote={onRestoreNote}
        onPermanentDeleteNote={onPermanentDeleteNote}
        onEmptyNoteTrash={onEmptyTrash}
        onBack={() => setShowTrash(false)}
      />
    );
  }

  return (
    <div>


      {draftCount > 0 && (
        <button
          onClick={() => setShowOnlyDrafts((v) => !v)}
          className="text-[14px] font-semibold mb-2 flex items-center gap-2 py-1"
          style={{ color: "#F9A825" }}
        >
          <span
            className="animate-pulse shrink-0"
            style={{ width: 12, height: 12, borderRadius: "50%", background: "#F9A825" }}
          />
          ✏️ {draftCount} rascunho{draftCount > 1 ? "s" : ""} pendente{draftCount > 1 ? "s" : ""}
          <span style={{ textDecoration: "underline", marginLeft: 2 }}>
            {showOnlyDrafts ? "— ver todas" : "— ver rascunhos"}
          </span>
        </button>
      )}

      {/* Barra de Busca com Microfone e Botão Novo */}
      <div className="flex items-center gap-3 mb-2">
        <div
          className="relative flex-1 transition-all duration-200"
          style={{
            border: searchFocused || isListening ? "1.5px solid #B39DDB" : "1.5px solid #EBEBEB",
            borderRadius: 16,
            background: "#FFFFFF",
            boxShadow: searchFocused || isListening ? "0 0 0 3px rgba(179,157,219,0.15), 0 2px 8px -2px rgba(0,0,0,0.06)" : "0 2px 8px -2px rgba(0,0,0,0.04)",
          }}
        >
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#BDBDBD]" />
          <input
            placeholder="Buscar notas..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="w-full pl-9 pr-12 py-2.5 bg-transparent border-0 outline-none text-sm font-medium text-[#1A1A2E]"
            style={{ borderRadius: 16 }}
          />

          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {voiceSupported && (
              <button
                onClick={toggleVoice}
                className="p-1.5 rounded-full transition-all duration-200"
                style={{ color: isListening ? "#E53935" : "#BDBDBD", background: isListening ? "rgba(229,57,53,0.1)" : "transparent" }}
                title={isListening ? "Parar busca por voz" : "Buscar por voz"}
              >
                {isListening ? (
                  <div className="relative">
                    <MicOff size={16} />
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  </div>
                ) : (
                  <Mic size={16} />
                )}
              </button>
            )}
          </div>
        </div>

        <button
          onClick={openNew}
          className="shrink-0 flex items-center justify-center transition-all duration-200 hover:scale-105 active:scale-95"
          style={{ width: 46, height: 46, borderRadius: 14, background: "#1A1A2E", boxShadow: "0 4px 14px -2px rgba(26,26,46,0.35)" }}
          title="Criar nova nota"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 4V16M4 10H16" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>


      </div>


      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-[#BDBDBD]">
          {carregando && notes.length === 0 ? "Carregando notas…" : `${filtered.length} ${filtered.length === 1 ? "nota" : "notas"}`}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#F0EDE8]">
            <span className="text-3xl">📝</span>
          </div>
          <p className="mt-4 text-sm font-semibold text-[#BDBDBD]">
            {search ? "Nenhuma nota encontrada para essa busca" : "Nenhuma nota encontrada"}
          </p>
          <p className="text-xs mt-1 font-medium text-[#D5D5D5]">
            {search ? "Tente outro termo" : "Toque em + para criar uma nova nota"}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {(() => {
            const pinnedIds = filtered.filter((n) => n.isPinned).map((n) => n.id);
            return filtered.map((note) => {
              const pinnedIdx = pinnedIds.indexOf(note.id);
              return (
                <NoteCard
                  key={note.id}
                  note={note}
                  onDelete={handleDeleteWithConfirm}
                  onClick={openEdit}
                  onBellClick={handleBellClick}
                  onLockClick={handleLockClick}
                  onPinClick={handlePinClick}
                  searchQuery={search}
                  fontSize={fontSizeMap[fontSize]}
                  onMoveUp={note.isPinned && pinnedIdx > 0 ? () => onReorderPin?.(note.id, -1) : undefined}
                  onMoveDown={note.isPinned && pinnedIdx < pinnedIds.length - 1 ? () => onReorderPin?.(note.id, 1) : undefined}
                />
              );
            });
          })()}
        </div>
      )}

      <NoteEditor
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v);
          // Ao fechar a nota, volta a lista pro topo (onde ficam as mais
          // recentes) — sem isso, a rolagem ficava do jeito que estava
          // antes de abrir a nota.
          if (!v) window.scrollTo({ top: 0, behavior: "auto" });
        }}
        editingNote={editingNote}
        readOnly={editorReadOnly}
        onSetReadOnly={setEditorReadOnly}
        onSave={handleSave}
        onSchedule={onAddAppointment ? (noteTitle, noteContent, date, time, sound) => {
          onAddAppointment(noteTitle || "Nota sem título", new Date(date + "T00:00:00"), time, noteContent, sound);
        } : undefined}
        onDelete={onDelete}
      />

      <ReminderModal
        open={!!reminderNote}
        onOpenChange={(v) => { if (!v) setReminderNote(null); }}
        noteTitle={reminderNote?.title || ""}
        existingDate={reminderNote?.reminderDate}
        existingTime={reminderNote?.reminderTime}
        existingSound={reminderNote?.reminderSound}
        existingNativeSoundUri={reminderNote?.reminderNativeSoundUri}
        existingNativeSoundName={reminderNote?.reminderNativeSoundName}
        onSave={handleReminderSave}
        onRemove={handleReminderRemove}
      />

      <LockNoteModal
        open={!!lockNote}
        onOpenChange={(v) => { if (!v) { setLockNote(null); setPendingUnlockNote(null); } }}
        mode={lockMode}
        onSetPin={handleSetPin}
        onUnlock={lockMode === "manage" ? handleManageRemove : handleUnlockAttempt}
        onRemoveLock={handleRemoveLock}
        onForceReset={handleForceReset}
      />

      <Dialog open={!!confirmDeleteId} onOpenChange={(v) => { if (!v) setConfirmDeleteId(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display">
              🗑 Mover para a lixeira?
            </DialogTitle>
            <DialogDescription>
              A nota pode ser recuperada em até 30 dias.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm font-semibold px-1 text-[#1A1A2E]">
            "{confirmDeleteTitle}"
          </p>
          <div className="flex gap-2 mt-1">
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)} className="flex-1">Cancelar</Button>
            <Button variant="destructive" onClick={confirmDelete} className="flex-1 gap-1">
              <Trash2 size={14} /> Mover para lixeira
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {showRelatorio && (
        <Suspense fallback={null}>
        <RelatorioTurno
          initialState={relatorioInitialState}
          iniciarNovo={relatorioNovo}
          onOpenRebobinadeira={() => { setShowRelatorio(false); setRebobInitialState(null); setRebobNovo(relatorioNovo); setShowRebobinadeira(true); }}
          onClose={() => { setShowRelatorio(false); setRelatorioInitialState(null); setRelatorioNovo(false); }}
          onSaveAsNote={(title, content) => {
            const existing = notes.find(n => n.title === title);
            if (existing) {
              onUpdate(existing.id, title, content, [], existing.color || "bg-blue-100", "default", "medium", "publicada");
            } else {
              onAdd(title, content, [], "bg-blue-100", "default", "medium", "publicada");
            }
            setShowRelatorio(false);
            setRelatorioInitialState(null);
            setRelatorioNovo(false);
          }}
        />
        </Suspense>
      )}

      {showRebobinadeira && (
        <Suspense fallback={null}>
        <RelatorioRebobinadeira
          initialState={rebobInitialState}
          iniciarNovo={rebobNovo}
          onClose={() => { setShowRebobinadeira(false); setRebobInitialState(null); setRebobNovo(false); }}
          onSaveAsNote={(title, content) => {
            const existing = notes.find(n => n.title === title);
            if (existing) {
              onUpdate(existing.id, title, content, [], existing.color || "bg-green-100", "default", "medium", "publicada");
            } else {
              onAdd(title, content, [], "bg-green-100", "default", "medium", "publicada");
            }
            setShowRebobinadeira(false);
            setRebobInitialState(null);
            setRebobNovo(false);
          }}
        />
        </Suspense>
      )}
    </div>
  );
}
