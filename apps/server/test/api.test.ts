import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { execa } from 'execa';
import type {
  AdeEvent,
  AgentPresetInfo,
  AgentRunInfo,
  AgentStreamEvent,
  ClaudeAuthStatus,
  ClaudeUsage,
  GitHubAuthStatus,
  ProjectInfo,
  WorktreeInfo,
  WorktreeSummary,
} from '@ade/shared';
import { buildApp } from '../src/app.js';
import type { AgentPreset } from '../src/config.js';
import { AgentProcessManager } from '../src/services/AgentProcessManager.js';
import { ClaudeAuthService } from '../src/services/ClaudeAuthService.js';
import { GitHubAuthService } from '../src/services/GitHubAuthService.js';
import { UsageService } from '../src/services/UsageService.js';
import { defaultAgentPresets } from '../src/config.js';
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
  // `sleep` final: node-pty puede perder la última salida si el proceso sale justo
  // después de escribirla (carrera del PTY, no de ADE). Los agentes reales no terminan así.
  echo: bash('echo', 'echo hola; read l; echo "got:$l"; sleep 0.2'),
  writer: { label: 'writer', command: 'bash', args: (p) => ['-c', `echo "${p}" > agent.txt; echo done`], acceptsPrompt: true },
  sleeper: bash('sleeper', 'sleep 30'),
  stubborn: bash('stubborn', "trap '' TERM; echo ready; while true; do sleep 0.1; done"),
  modal: {
    label: 'modal',
    command: 'bash',
    args: (_p, mode) => ['-c', `echo "mode=${mode ?? 'none'}"; sleep 0.2`],
    acceptsPrompt: false,
    modes: ['manual', 'auto', 'plan'],
  },
  envcheck: {
    ...bash('envcheck', 'echo "key=[$ANTHROPIC_API_KEY] home=[${HOME:+ok}]"; sleep 0.2'),
    unsetEnv: ['ANTHROPIC_API_KEY'],
  },
};

// `gh` falso: estado por fichero, login por código de un solo uso.
const FAKE_GH = `#!/usr/bin/env bash
case "$1 $2" in
  "--version "*) echo "gh version 2.89.0 (2026-03-26)" ;;
  "auth status")
    if [ -f "$FAKE_GH_STATE" ]; then
      echo '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"hiroshitomi","tokenSource":"keyring","gitProtocol":"https"}]}}'
    else echo '{"hosts":{}}'; fi ;;
  "auth login")
    echo "! First copy your one-time code: ABCD-1234"
    printf "Press Enter to open https://github.com/login/device in your browser... "; read -r
    touch "$FAKE_GH_STATE"; echo "✓ Logged in as hiroshitomi"; sleep 0.2 ;;
  "auth logout") [ "$5" = "--user" ] && rm -f "$FAKE_GH_STATE" ;;
esac
`;

// `claude` falso: imita `--version`, `auth status --json` y `auth login`. Si ve
// ANTHROPIC_API_KEY responde como Claude Code (método api_key), así el test
// comprueba que ADE la quita del entorno.
const FAKE_CLAUDE = `#!/usr/bin/env bash
case "$1 $2" in
  "--version "*) echo "9.9.9 (Claude Code)" ;;
  "auth status")
    if [ -n "$ANTHROPIC_API_KEY" ]; then
      echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty","apiKeySource":"ANTHROPIC_API_KEY"}'
    elif [ -f "$FAKE_CLAUDE_STATE" ]; then
      echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"dev@example.com","subscriptionType":"max"}'
    else
      echo '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}'
    fi ;;
  "auth login")
    echo "Abre esta URL para iniciar sesión: https://claude.ai/oauth/authorize?code=true"
    printf "Pega el código aquí: "; read -r code
    [ "$3" = "--claudeai" ] && [ "$code" = "abc123" ] && touch "$FAKE_CLAUDE_STATE" && echo "Login successful"
    sleep 0.2 ;;
  "auth logout") rm -f "$FAKE_CLAUDE_STATE" ;;
esac
`;

let tmp: string;
let base: string;
let app: ReturnType<typeof buildApp>;
let agents: AgentProcessManager;
let claude: ClaudeAuthService;
let fakeClaude: string;
let repoPath: string;
let usage: UsageService;
const USAGE_TOKEN = 'token-de-prueba';

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
async function readStream<E extends { type: string } = AgentStreamEvent>(
  url: string,
  until: (events: E[]) => boolean = () => false,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${url}`, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/event-stream/);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: E[] = [];
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
  const output = events.map((e) => ('data' in e && typeof e.data === 'string' ? e.data : '')).join('');
  return { events, ids, output };
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
  repoPath = repo;
  await execa('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), 'hola\n');
  await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'readme'], { cwd: repo });

  const git = await GitWorktreeService.create({ repoPath: repo, worktreesDir: path.join(tmp, 'wts') });
  fakeClaude = path.join(tmp, 'fake-claude');
  await writeFile(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });
  process.env.FAKE_CLAUDE_STATE = path.join(tmp, 'claude-logged-in');
  presets['claude-login'] = {
    label: 'login',
    command: fakeClaude,
    args: () => ['auth', 'login', '--claudeai'],
    acceptsPrompt: false,
    unsetEnv: ['ANTHROPIC_API_KEY'],
    hidden: true,
  };
  const fakeGh = path.join(tmp, 'fake-gh');
  await writeFile(fakeGh, FAKE_GH, { mode: 0o755 });
  process.env.FAKE_GH_STATE = path.join(tmp, 'gh-logged-in');
  presets['gh-login'] = {
    label: 'gh',
    command: fakeGh,
    args: () => ['auth', 'login', '--web'],
    acceptsPrompt: false,
    hidden: true,
  };
  agents = new AgentProcessManager({ presets, killTimeoutMs: 300, idleMs: 300 });
  claude = new ClaudeAuthService({ agents, command: fakeClaude });
  const github = new GitHubAuthService({ agents, command: fakeGh });
  usage = new UsageService(path.join(tmp, 'usage.json'));
  app = buildApp({
    git,
    agents,
    claude,
    github,
    usage,
    usageReportToken: USAGE_TOKEN,
    allowedOrigins: ['http://localhost:5173'],
    logger: false,
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
    assert.match(output, /got:mundo/, JSON.stringify(events.at(-1)));
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

  test('detecta cuándo el agente espera input y lo publica en /api/events', async () => {
    const wt = await createWorktree('espera');
    const run = await startAgent(wt.id, 'echo');
    const forRun = (evs: AdeEvent[]) =>
      evs.flatMap((e) => (e.type === 'agent' && e.run.id === run.id ? [e.run] : []));

    // `echo hola; read l` se queda callado esperando: tras idleMs pasa a 'waiting'.
    const waiting = await readStream<AdeEvent>('/api/events', (evs) =>
      forRun(evs).some((r) => r.activity === 'waiting'),
    );
    assert.ok(forRun(waiting.events).length > 0);
    const list = await api<WorktreeSummary[]>('GET', '/api/worktrees');
    assert.equal(list.body.find((w) => w.id === wt.id)!.agent?.activity, 'waiting');

    // Al responder vuelve a producir salida y termina: el último estado es exited sin actividad.
    const done = readStream<AdeEvent>('/api/events', (evs) => forRun(evs).some((r) => r.status === 'exited'));
    await new Promise((r) => setTimeout(r, 50));
    await api('POST', `/api/agents/${run.id}/input`, { data: 'ok\r' });
    const final = forRun((await done).events).at(-1)!;
    assert.equal(final.status, 'exited');
    assert.equal(final.activity, null);
    await api('DELETE', `/api/worktrees/${wt.id}`);
  });

  test('los agentes de Claude no reciben ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-de-prueba';
    try {
      const wt = await createWorktree('sin api key');
      const run = await startAgent(wt.id, 'envcheck');
      await waitFor(async () => agents.get(run.id).status === 'exited');
      const { output } = await readStream(`/api/agents/${run.id}/stream`);
      assert.match(output, /key=\[\] home=\[ok\]/); // se quita solo esa variable, el resto se hereda
      await api('DELETE', `/api/worktrees/${wt.id}`);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test('estado y login de Claude con la suscripción', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-de-prueba';
    try {
      let status = (await api<ClaudeAuthStatus>('GET', '/api/claude/status')).body;
      assert.equal(status.installed, true);
      assert.equal(status.version, '9.9.9');
      assert.equal(status.loggedIn, false);
      assert.deepEqual(status.ignoredEnvVars, ['ANTHROPIC_API_KEY']);

      // El preset de login es interno: ni se lista ni se puede lanzar desde /api/agents.
      const presetsList = (await api<AgentPresetInfo[]>('GET', '/api/agents/presets')).body;
      assert.ok(!presetsList.some((p) => p.id === 'claude-login'));
      const wt = await createWorktree('preset oculto');
      assert.equal((await api('POST', '/api/agents', { worktreeId: wt.id, preset: 'claude-login' })).status, 400);
      await api('DELETE', `/api/worktrees/${wt.id}`);

      const login = await api<AgentRunInfo>('POST', '/api/claude/login');
      assert.equal(login.status, 201);
      // Un segundo clic no abre otro login: devuelve el que está en curso.
      assert.equal((await api<AgentRunInfo>('POST', '/api/claude/login')).body.id, login.body.id);
      await readStream(`/api/agents/${login.body.id}/stream`, (evs) =>
        evs.some((e) => e.type === 'output' && e.data.includes('Pega el código')),
      );
      await api('POST', `/api/agents/${login.body.id}/input`, { data: 'abc123\r' });
      const { output } = await readStream(`/api/agents/${login.body.id}/stream`);
      assert.match(output, /Login successful/);

      status = (await api<ClaudeAuthStatus>('GET', '/api/claude/status')).body;
      assert.equal(status.loggedIn, true);
      assert.equal(status.usesSubscription, true); // con la API key presente en el server, aun así
      assert.equal(status.email, 'dev@example.com');
      assert.equal(status.subscriptionType, 'max');

      status = (await api<ClaudeAuthStatus>('POST', '/api/claude/logout')).body;
      assert.equal(status.loggedIn, false);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test('información del proyecto: rama, cambios y remoto sin credenciales', async () => {
    let info = (await api<ProjectInfo>('GET', '/api/project')).body;
    assert.equal(info.name, 'repo');
    assert.equal(info.branch, 'main');
    assert.equal(info.remote, null);
    assert.equal(info.upstream, null);

    await execa('git', ['remote', 'add', 'origin', 'https://usuario:ghp_SECRETO@github.com/acme/web-app.git'], { cwd: repoPath });
    await writeFile(path.join(repoPath, 'nuevo.txt'), 'x');
    try {
      const res = await api<ProjectInfo>('GET', '/api/project');
      info = res.body;
      assert.equal(info.changes, 1);
      assert.equal(info.remote?.url, 'https://github.com/acme/web-app.git');
      assert.deepEqual(info.remote?.github, { owner: 'acme', repo: 'web-app', url: 'https://github.com/acme/web-app' });
      assert.ok(!JSON.stringify(res.body).includes('SECRETO'));
    } finally {
      await execa('git', ['remote', 'remove', 'origin'], { cwd: repoPath });
      await rm(path.join(repoPath, 'nuevo.txt'));
    }
  });

  test('cuenta de GitHub: estado, login por terminal y logout', async () => {
    let status = (await api<GitHubAuthStatus>('GET', '/api/github/status')).body;
    assert.equal(status.installed, true);
    assert.equal(status.version, '2.89.0');
    assert.equal(status.loggedIn, false);

    const login = (await api<AgentRunInfo>('POST', '/api/github/login')).body;
    await readStream(`/api/agents/${login.id}/stream`, (evs) =>
      evs.some((e) => e.type === 'output' && e.data.includes('ABCD-1234')),
    );
    await api('POST', `/api/agents/${login.id}/input`, { data: '\r' });
    assert.match((await readStream(`/api/agents/${login.id}/stream`)).output, /Logged in as hiroshitomi/);

    status = (await api<GitHubAuthStatus>('GET', '/api/github/status')).body;
    assert.equal(status.loggedIn, true);
    assert.equal(status.login, 'hiroshitomi');
    assert.equal(status.tokenSource, 'keyring');

    status = (await api<GitHubAuthStatus>('POST', '/api/github/logout')).body;
    assert.equal(status.loggedIn, false);
  });

  test('uso de la suscripción: la status line real de Claude reporta a ADE', async () => {
    // El comando exacto que ADE pasa a Claude Code con --settings.
    const args = defaultAgentPresets.claude!.args('hola');
    assert.equal(args[0], '--settings');
    assert.equal(args.at(-1), 'hola');
    const command = (JSON.parse(args[1]!) as { statusLine: { command: string } }).statusLine.command;

    const resets5h = Math.floor(Date.now() / 1000) + 3600;
    const resets7d = Math.floor(Date.now() / 1000) + 3 * 86400;
    const sessionJson = JSON.stringify({
      model: { display_name: 'Opus' },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: resets5h },
        seven_day: { used_percentage: 41.2, resets_at: resets7d },
      },
    });

    const events = readStream<AdeEvent>('/api/events', (evs) =>
      evs.some((e) => e.type === 'usage' && e.usage.fiveHour?.usedPercentage === 23.5),
    );
    await new Promise((r) => setTimeout(r, 50));
    // Claude Code ejecuta la status line con sh, pasando el JSON por stdin.
    const line = await execa('sh', ['-c', command], {
      input: sessionJson,
      env: { ADE_USAGE_URL: `${base}/api/usage/report`, ADE_USAGE_TOKEN: USAGE_TOKEN },
    });
    assert.equal(line.stdout, 'ADE · Opus · 5h 24% · semana 41%');
    await events; // llegó por /api/events

    const current = (await api<ClaudeUsage>('GET', '/api/usage')).body;
    assert.equal(current.fiveHour?.usedPercentage, 23.5);
    assert.equal(current.fiveHour?.resetsAt, new Date(resets5h * 1000).toISOString());
    assert.equal(current.sevenDay?.usedPercentage, 41.2);
    assert.ok(current.updatedAt);

    // Sin el token correcto no se acepta (cualquier proceso local podría intentarlo).
    const forged = await api('POST', '/api/usage/report', { fiveHour: null, sevenDay: null }, { 'x-ade-token': 'otro' });
    assert.equal(forged.status, 403);

    // Persistido en disco y con caducidad: pasado el reinicio, la ventana se vacía.
    const reloaded = new UsageService(path.join(tmp, 'usage.json'));
    await reloaded.load();
    assert.equal(reloaded.get().sevenDay?.usedPercentage, 41.2);
    assert.equal(reloaded.get(Date.now() + 2 * 3600 * 1000).fiveHour, null);
  });

  test('Claude Code no instalado', async () => {
    const missing = new ClaudeAuthService({ agents, command: path.join(tmp, 'no-existe') });
    const status = await missing.status();
    assert.equal(status.installed, false);
    assert.equal(status.loggedIn, false);
  });

  test('modos de permisos: se pasan al agente y se validan', async () => {
    const presetsList = (await api<AgentPresetInfo[]>('GET', '/api/agents/presets')).body;
    assert.deepEqual(presetsList.find((p) => p.id === 'modal')?.modes, ['manual', 'auto', 'plan']);
    assert.deepEqual(presetsList.find((p) => p.id === 'echo')?.modes, []);

    const wt = await createWorktree('con modo');
    const run = (await api<AgentRunInfo>('POST', '/api/agents', { worktreeId: wt.id, preset: 'modal', mode: 'plan' })).body;
    assert.equal(run.mode, 'plan');
    await waitFor(async () => agents.get(run.id).status === 'exited');
    assert.match((await readStream(`/api/agents/${run.id}/stream`)).output, /mode=plan/);

    // Sin modo: el predeterminado del preset (el primero), visible en la UI.
    const def = (await api<AgentRunInfo>('POST', '/api/agents', { worktreeId: wt.id, preset: 'modal' })).body;
    assert.equal(def.mode, 'manual');
    await waitFor(async () => agents.get(def.id).status === 'exited');

    // Un agente sin modos rechaza el parámetro; un modo inventado no pasa el esquema.
    assert.equal((await api('POST', '/api/agents', { worktreeId: wt.id, preset: 'sleeper', mode: 'auto' })).status, 400);
    assert.equal((await api('POST', '/api/agents', { worktreeId: wt.id, preset: 'modal', mode: 'yolo' })).status, 400);
    await api('DELETE', `/api/worktrees/${wt.id}`);
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
