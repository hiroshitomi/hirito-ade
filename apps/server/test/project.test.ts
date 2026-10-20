import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { execa } from 'execa';
import type { AgentRunInfo, FolderListing, ProjectInfo, ProjectState, WorktreeInfo, WorktreeSummary } from '@ade/shared';
import { buildApp } from '../src/app.js';
import type { AgentPreset } from '../src/config.js';
import { pickerCommands, pickFolder } from '../src/lib/folderPicker.js';
import { AgentProcessManager } from '../src/services/AgentProcessManager.js';
import { ClaudeAuthService } from '../src/services/ClaudeAuthService.js';
import { GitHubAuthService } from '../src/services/GitHubAuthService.js';
import { ProjectService } from '../src/services/ProjectService.js';
import { UsageService } from '../src/services/UsageService.js';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const presets: Record<string, AgentPreset> = {
  sleeper: { label: 'sleeper', command: 'bash', args: () => ['-c', 'sleep 30'], acceptsPrompt: false },
};

let tmp: string;
let ws: string;
let base: string;
let app: ReturnType<typeof buildApp>;
let agents: AgentProcessManager;
let pickResult: Awaited<ReturnType<typeof pickFolder>> = { status: 'cancelled' };

async function api<T = unknown>(method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function initRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await writeFile(path.join(dir, 'README.md'), `# ${path.basename(dir)}\n`);
  await execa('git', ['add', '-A'], { cwd: dir });
  await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: dir });
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ade-proj-'));
  // Workspace como el del usuario: varios repos + .claude/skills en la raíz.
  ws = path.join(tmp, 'sys-cloud');
  await initRepo(path.join(ws, 'front'));
  await initRepo(path.join(ws, 'back'));
  await mkdir(path.join(ws, 'notas'));
  await mkdir(path.join(ws, '.cache'));
  await mkdir(path.join(ws, '.claude', 'skills', 'analisis'), { recursive: true });

  agents = new AgentProcessManager({ presets, killTimeoutMs: 300 });
  const project = new ProjectService({ agents, stateFile: path.join(tmp, 'projects.json'), worktreesRoot: path.join(tmp, 'wts') });
  await project.loadState();
  app = buildApp({
    project,
    agents,
    claude: new ClaudeAuthService({ agents, command: path.join(tmp, 'no-claude') }),
    github: new GitHubAuthService({ agents, command: path.join(tmp, 'no-gh') }),
    usage: new UsageService(path.join(tmp, 'usage.json')),
    usageReportToken: 't',
    allowedOrigins: [],
    logger: false,
    pickFolder: async () => pickResult,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await agents.stopAll();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

describe('Proyectos', () => {
  test('sin proyecto: estado vacío y crear tarea da NO_PROJECT', async () => {
    const state = (await api<ProjectState>('GET', '/api/project')).body;
    assert.equal(state.project, null);
    assert.deepEqual(state.recent, []);
    assert.deepEqual((await api('GET', '/api/worktrees')).body, []);
    const res = await api<{ error: string }>('POST', '/api/worktrees/create', { name: 'x' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'NO_PROJECT');
  });

  test('navegador de carpetas: marca repos y omite ocultas', async () => {
    const list = (await api<FolderListing>('GET', `/api/project/browse?path=${encodeURIComponent(ws)}`)).body;
    assert.deepEqual(
      list.entries.map((e) => [e.name, e.isRepo]),
      [
        ['back', true],
        ['front', true],
        ['notas', false],
      ],
    );
    assert.equal(list.repoCount, 2);
    assert.equal(list.isRepo, false);
    assert.equal(list.parent, tmp);
    assert.ok(list.roots.some((r) => r.path === os.homedir()));
    assert.equal((await api('GET', `/api/project/browse?path=${encodeURIComponent(path.join(tmp, 'nada'))}`)).status, 400);
  });

  test('abrir una carpeta que no es repo ni workspace da un error claro', async () => {
    const res = await api<{ message: string }>('POST', '/api/project/open', { path: path.join(ws, 'notas') });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /ni contiene repositorios/);
  });

  test('workspace: detecta repos y skills, tareas por repo y sin solapes entre repos', async () => {
    const opened = (await api<ProjectInfo>('POST', '/api/project/open', { path: ws })).body;
    assert.equal(opened.kind, 'workspace');
    assert.equal(opened.name, 'sys-cloud');
    assert.deepEqual(opened.repos.map((r) => r.name), ['back', 'front']);
    assert.equal(opened.skillsPath, path.join(ws, '.claude', 'skills'));

    // En un workspace hay que elegir el repo.
    const noRepo = await api<{ message: string }>('POST', '/api/worktrees/create', { name: 'sin repo' });
    assert.equal(noRepo.status, 400);
    assert.match(noRepo.body.message, /back, front/);

    const f = (await api<WorktreeInfo>('POST', '/api/worktrees/create', { repo: 'front', name: 'login front' })).body;
    const b = (await api<WorktreeInfo>('POST', '/api/worktrees/create', { repo: 'back', name: 'login back' })).body;
    assert.equal(f.repo, 'front');
    assert.equal(b.repo, 'back');
    // Mismo fichero relativo en ambos repos: NO es un solape (son ficheros distintos).
    await writeFile(path.join(f.path, 'README.md'), 'front cambiado\n');
    await writeFile(path.join(b.path, 'README.md'), 'back cambiado\n');

    const list = (await api<WorktreeSummary[]>('GET', '/api/worktrees')).body;
    assert.deepEqual(list.map((w) => [w.repo, w.id]).sort(), [['back', b.id], ['front', f.id]].sort());
    assert.ok(list.every((w) => w.overlaps.length === 0));

    // Las operaciones por id encuentran el repo correcto.
    const diff = (await api<{ files: { path: string }[] }>('GET', `/api/worktrees/${b.id}/diff`)).body;
    assert.deepEqual(diff.files.map((x) => x.path), ['README.md']);
    assert.equal((await api('DELETE', `/api/worktrees/${f.id}?force=true`)).status, 204);
    assert.equal((await api('GET', `/api/worktrees/${f.id}`)).status, 404);
  });

  test('no se cambia de proyecto con agentes en marcha', async () => {
    const list = (await api<WorktreeSummary[]>('GET', '/api/worktrees')).body;
    const run = (await api<AgentRunInfo>('POST', '/api/agents', { worktreeId: list[0]!.id, preset: 'sleeper' })).body;
    const blocked = await api<{ error: string }>('POST', '/api/project/open', { path: path.join(ws, 'front') });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'AGENTS_RUNNING');

    await api('POST', `/api/agents/${run.id}/stop`);
    const single = (await api<ProjectInfo>('POST', '/api/project/open', { path: path.join(ws, 'front') })).body;
    assert.equal(single.kind, 'repo');
    assert.deepEqual(single.repos.map((r) => r.name), ['front']);
    assert.equal(single.skillsPath, null);
  });

  test('recientes y reapertura del último proyecto al arrancar', async () => {
    const state = (await api<ProjectState>('GET', '/api/project')).body;
    assert.deepEqual(state.recent.map((r) => [r.name, r.kind]), [
      ['front', 'repo'],
      ['sys-cloud', 'workspace'],
    ]);

    const fresh = new ProjectService({ agents, stateFile: path.join(tmp, 'projects.json'), worktreesRoot: path.join(tmp, 'wts') });
    await fresh.loadState();
    await fresh.restoreLast();
    assert.equal((await fresh.info())?.path, path.join(ws, 'front'));
  });

  test('selector nativo: la ruta elegida vuelve a la UI', async () => {
    pickResult = { status: 'picked', path: ws };
    assert.deepEqual((await api('POST', '/api/project/pick')).body, { status: 'picked', path: ws });
  });
});

describe('Selector de carpetas del sistema', () => {
  test('comando por plataforma', () => {
    assert.equal(pickerCommands('win32')[0]!.command, 'powershell.exe');
    assert.match(pickerCommands('win32')[0]!.args.at(-1)!, /FolderBrowserDialog/);
    assert.equal(pickerCommands('darwin')[0]!.command, 'osascript');
    assert.deepEqual(pickerCommands('linux').map((c) => c.command), ['zenity', 'kdialog']);
  });

  test('elegida, cancelada o sin diálogo disponible', async () => {
    const sh = (script: string) => [{ command: 'sh', args: ['-c', script] }];
    assert.deepEqual(await pickFolder('darwin', sh('printf "/Users/h/proyecto/\\n"')), { status: 'picked', path: '/Users/h/proyecto' });
    assert.deepEqual(await pickFolder('linux', sh('exit 1')), { status: 'cancelled' });
    // El primero no existe: se prueba el siguiente; si ninguno existe, 'unsupported'.
    assert.deepEqual(
      await pickFolder('linux', [{ command: 'no-existe-zenity', args: [] }, ...sh('printf /home/h/ws')]),
      { status: 'picked', path: '/home/h/ws' },
    );
    assert.deepEqual(await pickFolder('linux', [{ command: 'no-existe-zenity', args: [] }]), { status: 'unsupported' });
  });
});
