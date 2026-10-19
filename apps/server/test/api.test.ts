import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { execa } from 'execa';
import type { AgentRunInfo, AgentStreamEvent, WorktreeInfo } from '@ade/shared';
import { buildApp } from '../src/app.js';
import type { AgentPreset } from '../src/config.js';
import { AgentProcessManager } from '../src/services/AgentProcessManager.js';
import { GitWorktreeService } from '../src/services/GitWorktreeService.js';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const bash = (label: string, script: string): AgentPreset => ({
  label,
  command: 'bash',
  args: () => ['-c', script],
  acceptsPrompt: false,
});

const presets: Record<string, AgentPreset> = {
  echo: bash('echo', 'echo hola; read l; echo "got:$l"'),
  writer: { label: 'writer', command: 'bash', args: (p) => ['-c', `echo "${p}" > agent.txt; echo done`], acceptsPrompt: true },
  sleeper: bash('sleeper', 'sleep 30'),
  stubborn: bash('stubborn', "trap '' TERM; echo ready; while true; do sleep 0.1; done"),
};

let tmp: string;
let base: string;
let app: ReturnType<typeof buildApp>;
let agents: AgentProcessManager;

async function api<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Lee el SSE hasta que `until` devuelva true o llegue `exit`. */
async function readStream(
  url: string,
  until: (events: AgentStreamEvent[]) => boolean = () => false,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${url}`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: AgentStreamEvent[] = [];
  const ids: string[] = [];
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split('\n').find((l) => l.startsWith('data: '));
        const id = frame.split('\n').find((l) => l.startsWith('id: '));
        if (id) ids.push(id.slice(4));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
      if (events.at(-1)?.type === 'exit' || until(events)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { events, ids, output: events.map((e) => (e.type === 'output' ? e.data : '')).join('') };
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'ade-api-'));
  const repo = path.join(tmp, 'repo');
  await execa('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), 'hola\n');
  await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'readme'], { cwd: repo });

  const git = await GitWorktreeService.create({ repoPath: repo, worktreesDir: path.join(tmp, 'wts') });
  agents = new AgentProcessManager({ presets, killTimeoutMs: 300 });
  app = buildApp({ git, agents, allowedOrigins: ['http://localhost:5173'], logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  await agents.stopAll();
  await app.close();
  await rm(tmp, { recursive: true, force: true });
});

const createWorktree = async (name: string) => {
  const res = await api<WorktreeInfo>('POST', '/api/worktrees/create', { name });
  assert.equal(res.status, 201);
  return res.body;
};

const startAgent = async (worktreeId: string, preset: string, prompt?: string) => {
  const res = await api<AgentRunInfo>('POST', '/api/agents', { worktreeId, preset, prompt });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

describe('API', () => {
  test('stream en vivo + input interactivo vía PTY', async () => {
    const wt = await createWorktree('interactivo');
    const run = await startAgent(wt.id, 'echo');

    const streamDone = readStream(`/api/agents/${run.id}/stream`);
    // Espera a que bash esté leyendo antes de teclear.
    await readStream(`/api/agents/${run.id}/stream`, (evs) => evs.some((e) => e.type === 'output' && e.data.includes('hola')));
    assert.equal((await api('POST', `/api/agents/${run.id}/input`, { data: 'mundo\r' })).status, 204);

    const { events, output } = await streamDone;
    assert.match(output, /got:mundo/);
    const exit = events.at(-1)!;
    assert.equal(exit.type, 'exit');
    assert.equal(exit.type === 'exit' && exit.run.exitCode, 0);
    assert.equal((await api<AgentRunInfo>('GET', `/api/agents/${run.id}`)).body.status, 'exited');
  });

  test('replay tras terminar y reanudación con Last-Event-ID', async () => {
    const wt = await createWorktree('replay');
    const run = await startAgent(wt.id, 'writer', 'x');
    await waitFor(async () => agents.get(run.id).status === 'exited');

    const full = await readStream(`/api/agents/${run.id}/stream`);
    assert.match(full.output, /done/);
    const lastId = full.ids.at(-1)!;

    const resumed = await readStream(`/api/agents/${run.id}/stream`, undefined, { 'last-event-id': lastId });
    assert.deepEqual(resumed.events.map((e) => e.type), ['exit']);
  });

  test('flujo completo: agente escribe → diff → merge', async () => {
    const wt = await createWorktree('flujo completo');
    const run = await startAgent(wt.id, 'writer', 'contenido del agente');
    await waitFor(async () => agents.get(run.id).status === 'exited');

    const diff = await api<{ files: { path: string; status: string }[] }>('GET', `/api/worktrees/${wt.id}/diff`);
    assert.deepEqual(diff.body.files.map((f) => [f.path, f.status]), [['agent.txt', 'A']]);

    const merge = await api<{ status: string; removed: boolean }>('POST', '/api/worktrees/merge', { id: wt.id });
    assert.equal(merge.status, 200, JSON.stringify(merge.body));
    assert.equal(merge.body.status, 'merged');
    assert.equal((await api('GET', `/api/worktrees/${wt.id}`)).status, 404);
    assert.equal(agents.list({ worktreeId: wt.id }).length, 0);
  });

  test('no se fusiona con el agente activo; stop y delete', async () => {
    const wt = await createWorktree('activo');
    const run = await startAgent(wt.id, 'sleeper');

    assert.equal((await api('POST', '/api/agents', { worktreeId: wt.id, preset: 'sleeper' })).status, 409);
    assert.equal((await api('POST', '/api/worktrees/merge', { id: wt.id })).status, 409);
    const list = await api<{ id: string; agentRunning: boolean }[]>('GET', '/api/worktrees');
    assert.equal(list.body.find((w) => w.id === wt.id)!.agentRunning, true);

    const stopped = await api<AgentRunInfo>('POST', `/api/agents/${run.id}/stop`);
    assert.equal(stopped.body.status, 'stopped');
    assert.equal((await api('DELETE', `/api/worktrees/${wt.id}`)).status, 204);
  });

  test('DELETE detiene agentes; SIGKILL si ignoran SIGTERM', async () => {
    const wt = await createWorktree('terco');
    const run = await startAgent(wt.id, 'stubborn');
    await readStream(`/api/agents/${run.id}/stream`, (evs) => evs.some((e) => e.type === 'output' && e.data.includes('ready')));
    assert.equal((await api('DELETE', `/api/worktrees/${wt.id}`)).status, 204);
    assert.equal((await api('GET', `/api/agents/${run.id}`)).status, 404);
  });

  test('validación y seguridad', async () => {
    const wt = await createWorktree('validacion');
    assert.equal((await api('POST', '/api/agents', { worktreeId: wt.id, preset: 'rm -rf /' })).status, 400);
    assert.equal((await api('POST', '/api/agents', { worktreeId: wt.id, preset: 'echo', command: 'x' })).status, 400);
    assert.equal((await api('GET', '/api/worktrees/..%2F..%2Fetc')).status, 400);
    assert.equal((await api('GET', '/api/agents/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await api('GET', '/api/health', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await api('GET', '/api/health', undefined, { origin: 'http://localhost:5173' })).status, 200);
    await api('DELETE', `/api/worktrees/${wt.id}`);
  });
});
