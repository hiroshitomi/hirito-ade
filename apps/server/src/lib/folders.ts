import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FolderListing } from '@ade/shared';
import { InvalidInputError } from './errors.js';

/** Carpetas que nunca son repos ni workspaces y solo ensucian el listado. */
const SKIP = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information']);
const MAX_ENTRIES = 500;

/** `.git` puede ser una carpeta (repo normal) o un fichero (worktree o submódulo). */
export function isGitRepo(dir: string): boolean {
  return existsSync(path.join(dir, '.git'));
}

/** Subcarpetas directas que son repos git (para detectar un workspace). */
export async function findChildRepos(dir: string): Promise<{ name: string; path: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
    .filter((e) => isGitRepo(e.path))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Listado para el navegador de carpetas integrado (alternativa al diálogo del sistema).
 * Solo carpetas; las ocultas se omiten. Sin ruta, empieza en la carpeta personal.
 */
export async function listFolders(dir?: string, platform: NodeJS.Platform = process.platform): Promise<FolderListing> {
  const target = path.resolve(dir || os.homedir());
  let info;
  try {
    info = await stat(target);
  } catch {
    throw new InvalidInputError(`La carpeta '${target}' no existe`);
  }
  if (!info.isDirectory()) throw new InvalidInputError(`'${target}' no es una carpeta`);

  const real = await realpath(target);
  const dirents = await readdir(real, { withFileTypes: true }).catch(() => {
    throw new InvalidInputError(`Sin permiso para leer '${real}'`);
  });
  const entries = dirents
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, MAX_ENTRIES)
    .map((e) => {
      const p = path.join(real, e.name);
      return { name: e.name, path: p, isRepo: isGitRepo(p) };
    });

  const parent = path.dirname(real);
  return {
    path: real,
    parent: parent === real ? null : parent,
    isRepo: isGitRepo(real),
    repoCount: entries.filter((e) => e.isRepo).length,
    entries,
    roots: roots(platform),
  };
}

function roots(platform: NodeJS.Platform): FolderListing['roots'] {
  const list = [{ name: 'Carpeta personal', path: os.homedir() }];
  if (platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (existsSync(drive)) list.push({ name: `${letter}:`, path: drive });
    }
  } else {
    list.push({ name: '/', path: '/' });
  }
  return list;
}
