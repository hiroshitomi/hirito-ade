import { Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { AgentPresetInfo, WorktreeInfo } from '@ade/shared';
import { api, errorMessage } from '../api/client';
import { Button, ErrorText, Field, inputClass, Modal } from './ui';

interface Props {
  presets: AgentPresetInfo[];
  onClose: () => void;
  onCreated: (wt: WorktreeInfo) => void;
}

export function NewTaskDialog({ presets, onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [preset, setPreset] = useState(presets[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = presets.find((p) => p.id === preset);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const wt = await api.createWorktree({ name: name.trim(), baseRef: baseRef.trim() || undefined });
      if (preset) {
        // Si el agente no arranca, el worktree ya existe: lo abrimos igualmente y se puede relanzar.
        await api
          .startAgent({ worktreeId: wt.id, preset, prompt: selected?.acceptsPrompt ? prompt.trim() || undefined : undefined })
          .catch(() => undefined);
      }
      onCreated(wt);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Nueva tarea" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
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
        <Field label="Rama base" hint="Vacío = rama principal (main/master)">
          <input className={inputClass} value={baseRef} onChange={(e) => setBaseRef(e.target.value)} placeholder="main" />
        </Field>
        <Field label="Agente">
          <select className={inputClass} value={preset} onChange={(e) => setPreset(e.target.value)}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="">Ninguno (solo crear worktree)</option>
          </select>
        </Field>
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
