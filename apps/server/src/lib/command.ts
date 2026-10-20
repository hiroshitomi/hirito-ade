import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { AdeError } from './errors.js';

/**
 * Ejecutable a pasar a node-pty. En Linux/macOS el PTY busca en el PATH por sí mismo.
 * En Windows, ConPTY (CreateProcess) solo encuentra `.exe`: un `claude.cmd` instalado
 * con npm no arrancaría, así que se resuelve aquí la ruta completa con PATH + PATHEXT.
 *
 * Los `.cmd`/`.bat` se rechazan con un mensaje claro en lugar de envolverlos en
 * `cmd.exe /c`: cmd vuelve a interpretar los argumentos y el prompt del usuario
 * (comillas, &, |, ^…) podría romperse o ejecutar otra cosa.
 */
export function resolveCommand(
  command: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return command;
  // Ruta explícita: se respeta tal cual.
  if (/[\\/]/.test(command)) return command;

  const get = (name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] ?? '';
  const dirs = get('PATH').split(';').filter(Boolean);
  const hasExt = /\.[^.\\/]+$/.test(command);
  const exts = hasExt ? [''] : get('PATHEXT').split(';').filter(Boolean).concat(['']);

  let script: string | null = null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      if (!isFile(candidate)) continue;
      if (/\.(exe|com)$/i.test(candidate)) return candidate;
      if (/\.(cmd|bat)$/i.test(candidate)) script ??= candidate;
    }
  }

  if (script) {
    throw new AdeError(
      `'${command}' está instalado como script (${path.basename(script)}) y Windows no puede lanzarlo en una terminal. ` +
        (command === 'claude'
          ? 'Instala Claude Code con el instalador nativo (claude.exe): irm https://claude.ai/install.ps1 | iex'
          : `Instala la versión con ejecutable (.exe) de '${command}'.`),
      'AGENT_NEEDS_EXECUTABLE',
      400,
    );
  }
  throw new AdeError(`No se encuentra '${command}' en el PATH. ¿Está instalado?`, 'AGENT_NOT_INSTALLED', 400);
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Ruta usable dentro de un comando de shell en cualquier plataforma (Windows acepta `/`). */
export function shellPath(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.replace(/\\/g, '/') : p;
}
