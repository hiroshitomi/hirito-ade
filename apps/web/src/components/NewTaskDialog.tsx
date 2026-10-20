import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AgentMode, AgentPresetInfo, ClaudeAuthStatus, WorktreeInfo } from '@ade/shared';
import { loadPreferredMode, ModePicker } from './AgentMode';
import { api, errorMessage } from '../api/client';
import { Button, ErrorText, Field, inputClass, Modal } from './ui';

interface Props {
  presets: AgentPresetInfo[];
  claude: ClaudeAuthStatus | null;
  onConnectClaude: () => void;
  /** Repos del proyecto (más de uno = workspace: hay que elegir). */
  repos: string[];
  /** Subtarea: parte de la rama de otra tarea (y se fusionará en ella), en su mismo repo. */
  parent?: { branch: string; title: string; repo: string };
  onClose: () => void;
  onCreated: (wt: WorktreeInfo) => void;
}

export function NewTaskDialog({ presets, claude, onConnectClaude, repos, parent, onClose, onCreated }: Props) {
  const [repo, setRepo] = useState(() => parent?.repo ?? loadLastRepo(repos));
  const [name, setName] = useState('');
  const [baseRef, setBaseRef] = useState(parent?.branch ?? '');
  const [preset, setPreset] = useState(presets[0]?.id ?? '');
  const [mode, setMode] = useState<AgentMode | null>(() => loadPreferredMode(presets[0]?.modes ?? []));
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = presets.find((p) => p.id === preset);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      saveLastRepo(repo);
      const wt = await api.createWorktree({
        repo: repos.length > 1 ? repo : undefined,
        name: name.trim(),
        baseRef: baseRef.trim() || undefined,
      });
      if (preset) {
        // Si el agente no arranca, el worktree ya existe: lo abrimos igualmente y se puede relanzar.
        await api
          .startAgent({
            worktreeId: wt.id,
            preset,
            prompt: selected?.acceptsPrompt ? prompt.trim() || undefined : undefined,
            mode: selected?.modes.length && mode ? mode : undefined,
          })
          .catch(() => undefined);
      }
      onCreated(wt);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={parent ? `Nueva subtarea de «${parent.title}»` : 'Nueva tarea'} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-4">
        {repos.length > 1 ? (
          <Field label="Repositorio" hint={parent ? 'Una subtarea trabaja en el mismo repo que su tarea padre.' : undefined}>
            <select className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} disabled={!!parent}>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Nombre de la tarea" hint="Se usa para la rama: ade/<nombre>-<sufijo>">
          <input
            autoFocus
            required
            maxLength={200}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Arreglar validación del login"
          />
        </Field>
        <Field
          label="Rama base"
          hint={
            parent
              ? 'Parte del trabajo de la tarea padre y, al aprobarla, se fusiona en su rama (no en main).'
              : 'Vacío = rama principal (main/master)'
          }
        >
          <input className={inputClass} value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder="main" />
        </Field>
        <Field label="Agente">
          <select
            className={inputClass}
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              setMode(loadPreferredMode(presets.find((p) => p.id === e.target.value)?.modes ?? []));
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="">Ninguno (solo crear worktree)</option>
          </select>
        </Field>
        {preset === 'claude' && claude && !claude.usesSubscription ? (
          <p className="flex flex-wrap items-center gap-x-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {!claude.installed
              ? 'Claude Code no está instalado en esta máquina.'
              : !claude.loggedIn
                ? 'Claude Code no tiene sesión iniciada.'
                : 'Claude Code está facturando por API, no con tu suscripción.'}
            <button type="button" className="font-medium underline" onClick={onConnectClaude}>
              Conectar mi suscripción
            </button>
          </p>
        ) : null}
        {selected?.modes.length ? (
          <div className="space-y-1.5">
            <span className="text-sm font-medium text-zinc-300">Modo</span>
            <ModePicker modes={selected.modes} value={mode} onChange={setMode} />
          </div>
        ) : null}
        {selected?.acceptsPrompt ? (
          <Field label="Instrucciones para el agente" hint="Opcional: también puedes escribirle en la terminal">
            <textarea
              rows={4}
              className={inputClass}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Añade validación de email en el formulario de login y sus tests"
            />
          </Field>
        ) : null}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" disabled={busy || !name.trim()}>
            <Plus className="size-4" />
            {busy ? 'Creando…' : 'Crear tarea'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const REPO_KEY = 'ade.lastRepo';

/** Último repo elegido: en un workspace sueles trabajar varias veces seguidas en el mismo. */
function loadLastRepo(repos: string[]): string {
  try {
    const saved = localStorage.getItem(REPO_KEY);
    if (saved && repos.includes(saved)) return saved;
  } catch {
    // Sin almacenamiento: el primero.
  }
  return repos[0] ?? '';
}

function saveLastRepo(repo: string) {
  try {
    if (repo) localStorage.setItem(REPO_KEY, repo);
  } catch {
    // Ignorado: solo es una preferencia.
  }
}
