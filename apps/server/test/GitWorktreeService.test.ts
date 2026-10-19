import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { execa } from 'execa';
import { DirtyWorktreeError, InvalidInputError, MergeConflictError } from '../src/lib/errors.js';
import { GitWorktreeService, slugify } from '../src/services/GitWorktreeService.js';

// Aislar de la config git del usuario: así también se prueba la identidad de fallback.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

let tmp: string;
let repo: string;
let svc: GitWorktreeService;

const git = async (cwd: string, ...args: string[]) =>
  (await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd })).stdout;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ade-test-'));
  repo = path.join(tmp, 'repo');
  await execa('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), 'hola\n');
  await writeFile(path.join(repo, 'shared.txt'), 'línea original\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'init');
  svc = await GitWorktreeService.create({ repoPath: repo, worktreesDir: path.join(tmp, 'wts') });
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('GitWorktreeService', () => {
  test('slugify normaliza acentos y símbolos', () => {
    assert.equal(slugify('  Arreglar Login: ¡Ñandú! '), 'arreglar-login-nandu');
  });

  test('create + list: rama nueva, base registrada, gestionado', async () => {
    const wt = await svc.create({ name: 'Añadir feature X' });
    assert.match(wt.id, /^anadir-feature-x-[0-9a-f]{6}$/);
    assert.equal(wt.branch, `ade/${wt.id}`);
    assert.equal(wt.baseBranch, 'main');
    assert.ok(wt.managed && !wt.isMain);
    assert.ok(existsSync(path.join(wt.path, 'README.md')));

    const all = await svc.listWithStatus();
    assert.ok(all[0]!.isMain);
    assert.deepEqual(all.find((w) => w.id === wt.id)!.status, { dirty: false, ahead: 0, behind: 0 });
    await svc.remove(wt.id, { deleteBranch: true });
  });

  test('getDiff incluye commits, cambios sin commitear y ficheros nuevos', async () => {
    const wt = await svc.create({ name: 'diff' });
    await writeFile(path.join(wt.path, 'committed.txt'), 'a\n');
    await git(wt.path, 'add', '-A');
    await git(wt.path, 'commit', '-qm', 'c1');
    await writeFile(path.join(wt.path, 'README.md'), 'hola\nmundo\n');
    await writeFile(path.join(wt.path, 'untracked.txt'), 'x\ny\n');

    const diff = await svc.getDiff(wt.id);
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    assert.deepEqual(byPath['committed.txt'], { path: 'committed.txt', status: 'A', additions: 1, deletions: 0 });
    assert.deepEqual(byPath['README.md'], { path: 'README.md', status: 'M', additions: 1, deletions: 0 });
    assert.deepEqual(byPath['untracked.txt'], { path: 'untracked.txt', status: 'A', additions: 2, deletions: 0 });
    assert.match(diff.patch, /\+mundo/);

    // El índice real del worktree no se ha tocado: untracked.txt sigue sin trackear.
    assert.match(await git(wt.path, 'status', '--porcelain'), /\?\? untracked\.txt/);
    assert.deepEqual(await svc.getStatus(wt.id), { dirty: true, ahead: 1, behind: 0 });
    await svc.remove(wt.id, { force: true, deleteBranch: true });
  });

  test('merge en checkout: commitea pendientes, fusiona en main y limpia', async () => {
    const wt = await svc.create({ name: 'merge checkout' });
    await writeFile(path.join(wt.path, 'feature.txt'), 'nuevo\n');

    const res = await svc.merge(wt.id);
    assert.equal(res.status, 'merged');
    assert.equal(res.mode, 'checkout');
    assert.equal(await readFile(path.join(repo, 'feature.txt'), 'utf8'), 'nuevo\n');
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), res.commit);
    assert.equal((await git(repo, 'log', '-1', '--format=%P')).split(' ').length, 2); // --no-ff
    assert.ok(!existsSync(wt.path));
    assert.equal(await git(repo, 'branch', '--list', wt.branch!), '');
  });

  test('conflicto en checkout: aborta limpio y conserva el worktree', async () => {
    const wt = await svc.create({ name: 'conflict' });
    await writeFile(path.join(wt.path, 'shared.txt'), 'versión del agente\n');
    await writeFile(path.join(repo, 'shared.txt'), 'versión en main\n');
    await git(repo, 'commit', '-qam', 'cambio en main');

    await assert.rejects(svc.merge(wt.id), (err: unknown) => {
      assert.ok(err instanceof MergeConflictError);
      assert.deepEqual(err.conflicts, ['shared.txt']);
      return true;
    });
    assert.equal(await git(repo, 'status', '--porcelain'), '');
    assert.ok(existsSync(wt.path));
    assert.equal((await svc.getStatus(wt.id)).behind, 1);
    await svc.remove(wt.id, { force: true, deleteBranch: true });
  });

  test('merge por ref cuando la rama destino no está checkouteada', async () => {
    await git(repo, 'switch', '-qc', 'otra');
    try {
      const wt = await svc.create({ name: 'ref merge', baseRef: 'main' });
      await writeFile(path.join(wt.path, 'by-ref.txt'), 'ok\n');

      const res = await svc.merge(wt.id, { strategy: 'squash' });
      assert.equal(res.mode, 'ref');
      assert.equal(await git(repo, 'rev-parse', 'main'), res.commit);
      assert.equal(await git(repo, 'show', 'main:by-ref.txt'), 'ok');
      assert.equal((await git(repo, 'log', '-1', '--format=%P', 'main')).split(' ').length, 1); // squash
      assert.ok(!existsSync(path.join(repo, 'by-ref.txt'))); // checkout del usuario intacto
    } finally {
      await git(repo, 'switch', '-q', 'main');
    }
  });

  test('conflicto por ref no mueve la rama destino', async () => {
    await git(repo, 'switch', '-qc', 'otra2');
    try {
      const wt = await svc.create({ name: 'ref conflict', baseRef: 'main' });
      await writeFile(path.join(wt.path, 'shared.txt'), 'agente\n');
      await git(wt.path, 'commit', '-qam', 'agente');
      const before = await git(repo, 'rev-parse', 'main');
      // Cambio conflictivo en main sin checkout: worktree temporal.
      await git(repo, 'worktree', 'add', '-q', path.join(tmp, 'mainwt'), 'main');
      await writeFile(path.join(tmp, 'mainwt', 'shared.txt'), 'main\n');
      await git(path.join(tmp, 'mainwt'), 'commit', '-qam', 'main');
      await git(repo, 'worktree', 'remove', path.join(tmp, 'mainwt'));
      const mainSha = await git(repo, 'rev-parse', 'main');
      assert.notEqual(mainSha, before);

      await assert.rejects(svc.merge(wt.id), MergeConflictError);
      assert.equal(await git(repo, 'rev-parse', 'main'), mainSha);
      await svc.remove(wt.id, { deleteBranch: true });
    } finally {
      await git(repo, 'switch', '-q', 'main');
    }
  });

  test('remove rechaza worktrees sucios salvo force', async () => {
    const wt = await svc.create({ name: 'dirty' });
    await writeFile(path.join(wt.path, 'tmp.txt'), 'x');
    await assert.rejects(svc.remove(wt.id), DirtyWorktreeError);
    await svc.remove(wt.id, { force: true, deleteBranch: true });
    assert.equal((await svc.list({ managedOnly: true })).length, 0);
  });

  test('creaciones concurrentes no colisionan (mutex)', async () => {
    const created = await Promise.all(Array.from({ length: 5 }, (_, i) => svc.create({ name: `paralelo ${i}` })));
    assert.equal(new Set(created.map((w) => w.id)).size, 5);
    await Promise.all(created.map((w) => svc.remove(w.id, { deleteBranch: true })));
  });

  test('ids inválidos se rechazan (path traversal)', async () => {
    await assert.rejects(svc.get('../../etc'), InvalidInputError);
  });
});
