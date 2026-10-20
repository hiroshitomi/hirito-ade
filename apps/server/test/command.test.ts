import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { resolveCommand, shellPath } from '../src/lib/command.js';
import { AdeError } from '../src/lib/errors.js';

// La lógica de Windows se prueba en cualquier SO pasando platform = 'win32'.
describe('resolveCommand (Windows)', () => {
  let tmp: string;
  let npmDir: string;
  let exeDir: string;

  before(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ade-cmd-'));
    npmDir = path.join(tmp, 'npm');
    exeDir = path.join(tmp, 'bin');
    await Promise.all([
      import('node:fs/promises').then((fs) => fs.mkdir(npmDir)),
      import('node:fs/promises').then((fs) => fs.mkdir(exeDir)),
    ]);
    await writeFile(path.join(npmDir, 'claude.cmd'), '@echo off');
    await writeFile(path.join(npmDir, 'codex.cmd'), '@echo off');
    await writeFile(path.join(exeDir, 'gh.exe'), '');
  });

  after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const env = (dirs: string[]) => ({ Path: dirs.join(';'), PATHEXT: '.COM;.EXE;.BAT;.CMD' });

  test('en Linux/macOS no toca el comando', () => {
    assert.equal(resolveCommand('claude', {}, 'linux'), 'claude');
  });

  test('encuentra el .exe con ruta completa (PATH sin distinguir mayúsculas)', () => {
    assert.equal(resolveCommand('gh', env([npmDir, exeDir]), 'win32'), path.join(exeDir, 'gh.exe'));
  });

  test('prefiere un .exe aunque haya un .cmd antes en el PATH', async () => {
    await writeFile(path.join(exeDir, 'claude.exe'), '');
    try {
      assert.equal(resolveCommand('claude', env([npmDir, exeDir]), 'win32'), path.join(exeDir, 'claude.exe'));
    } finally {
      await rm(path.join(exeDir, 'claude.exe'));
    }
  });

  test('solo .cmd (instalado con npm): error claro con la solución', () => {
    assert.throws(
      () => resolveCommand('claude', env([npmDir]), 'win32'),
      (err: unknown) =>
        err instanceof AdeError && err.code === 'AGENT_NEEDS_EXECUTABLE' && /instalador nativo/.test(err.message),
    );
    assert.throws(() => resolveCommand('codex', env([npmDir]), 'win32'), /codex\.cmd/);
  });

  test('no instalado', () => {
    assert.throws(
      () => resolveCommand('nada', env([npmDir, exeDir]), 'win32'),
      (err: unknown) => err instanceof AdeError && err.code === 'AGENT_NOT_INSTALLED',
    );
  });

  test('rutas explícitas se respetan y las de shell usan /', () => {
    assert.equal(resolveCommand('C:\\tools\\x.exe', {}, 'win32'), 'C:\\tools\\x.exe');
    assert.equal(shellPath('C:\\Program Files\\nodejs\\node.exe', 'win32'), 'C:/Program Files/nodejs/node.exe');
    assert.equal(shellPath('/usr/bin/node', 'linux'), '/usr/bin/node');
  });
});
