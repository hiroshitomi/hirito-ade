import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import type { AgentRunInfo, AgentStreamEvent } from '@ade/shared';
import { api } from '../api/client';

const theme = {
  background: '#09090b', // zinc-950
  foreground: '#e4e4e7',
  cursor: '#a1a1aa',
  selectionBackground: '#3f3f46',
};

interface Props {
  run: AgentRunInfo;
  onExit?: (run: AgentRunInfo) => void;
  fontSize?: number;
}

/**
 * Terminal conectada a un agente: salida por SSE, teclado por POST /input.
 * Al montarse reproduce el buffer del servidor, así que reabrir la tarea muestra
 * todo lo que el agente escribió mientras no la mirabas.
 */
export function AgentTerminal({ run, onExit, fontSize = 13 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const el = containerRef.current!;
    const term = new Terminal({
      theme,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize,
      cursorBlink: true,
      scrollback: 10_000,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    let running = run.status === 'running';

    // Input: cola serializada para que las teclas lleguen en orden aunque el POST tarde.
    let queue = '';
    let sending = false;
    const flushInput = async () => {
      if (sending || !queue) return;
      sending = true;
      const data = queue;
      queue = '';
      await api.sendInput(run.id, data).catch(() => undefined);
      sending = false;
      void flushInput();
    };
    const dataSub = term.onData((d) => {
      if (!running) return;
      queue += d;
      void flushInput();
    });

    // Resize: ajusta al contenedor y avisa al PTY (debounced: arrastrar genera decenas de eventos).
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      fit.fit();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (running) api.resize(run.id, term.cols, term.rows).catch(() => undefined);
      }, 120);
    });
    observer.observe(el);

    // EventSource reconecta solo y reenvía Last-Event-ID: no hay salida duplicada.
    const es = new EventSource(api.streamUrl(run.id));
    es.addEventListener('output', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as Extract<AgentStreamEvent, { type: 'output' }>;
      term.write(ev.data);
    });
    es.addEventListener('exit', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as Extract<AgentStreamEvent, { type: 'exit' }>;
      running = false;
      es.close(); // si no, EventSource reconectaría al cerrarse el stream
      const label = ev.run.status === 'stopped' ? 'detenido' : `terminado (código ${ev.run.exitCode})`;
      term.write(`\r\n\x1b[2m── proceso ${label} ──\x1b[0m\r\n`);
      onExitRef.current?.(ev.run);
    });

    if (running) term.focus();

    return () => {
      es.close();
      observer.disconnect();
      clearTimeout(resizeTimer);
      dataSub.dispose();
      term.dispose();
    };
  }, [run.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="h-full w-full overflow-hidden bg-zinc-950 p-2" />;
}
