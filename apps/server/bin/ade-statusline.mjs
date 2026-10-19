#!/usr/bin/env node
// Status line que ADE instala en los agentes de Claude Code (vía `claude --settings`).
// Claude Code le pasa por stdin un JSON con la sesión; los límites de la suscripción
// llegan en `rate_limits` (solo planes Pro/Max). Los reenvía a ADE y pinta una línea
// corta en la terminal del agente. Nunca debe fallar ni tardar: Claude Code cancela
// la ejecución si llega una actualización nueva.

const chunks = [];
for await (const c of process.stdin) chunks.push(c);

let data = {};
try {
  data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  // JSON inválido: no hay nada que reportar.
}

const limits = data.rate_limits ?? {};
const url = process.env.ADE_USAGE_URL;
const token = process.env.ADE_USAGE_TOKEN;

if (url && token && (limits.five_hour || limits.seven_day)) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ade-token': token },
      body: JSON.stringify({ fiveHour: limits.five_hour ?? null, sevenDay: limits.seven_day ?? null }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // ADE caído o reiniciándose: la línea se pinta igualmente.
  }
}

const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : null);
const parts = [data.model?.display_name, pct(limits.five_hour) && `5h ${pct(limits.five_hour)}`, pct(limits.seven_day) && `semana ${pct(limits.seven_day)}`];
process.stdout.write(`ADE · ${parts.filter(Boolean).join(' · ') || 'Claude Code'}\n`);
