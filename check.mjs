// Vérificateur de disponibilité Japean — HTTP + mot-clé positif/négatif + SSL + latence.
// Alerte Discord (webhook) uniquement sur transition (panne / rétablissement), pas de spam.
// Exécuté par GitHub Actions (cron). Aucune dépendance externe (fetch natif Node >=18).
import fs from 'node:fs';
import tls from 'node:tls';

const CONFIG = JSON.parse(fs.readFileSync(new URL('./checks.json', import.meta.url)));
const STATE_PATH = new URL('./state.json', import.meta.url);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(STATE_PATH)); } catch { prev = {}; }

const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const TIMEOUT_MS = 20000;
const LAT_WARN = CONFIG.latencyWarnMs || 12000;
const iso = () => new Date().toISOString();

// PrestaShop insère souvent une espace insécable entre le montant et €.
const norm = (s) => s.replace(/ | /g, ' ');

async function runCheck(c) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(c.url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'JapeanMonitor/1.0 (+uptime check)' },
    });
    const body = norm(await res.text());
    const ms = Date.now() - start;
    const reasons = [];
    if (c.expectStatus && res.status !== c.expectStatus) reasons.push(`HTTP ${res.status} (attendu ${c.expectStatus})`);
    for (const kw of c.mustContain || []) if (!body.includes(norm(kw))) reasons.push(`manque « ${kw} »`);
    for (const kw of c.mustNotContain || []) if (body.includes(norm(kw))) reasons.push(`contient « ${kw} »`);
    for (const rx of c.mustNotMatch || []) if (new RegExp(rx).test(body)) reasons.push(`motif de panne détecté (prix 0 € sur une tuile)`);
    if (ms > LAT_WARN) reasons.push(`lenteur ${(ms / 1000).toFixed(1)} s`);
    return { ok: reasons.length === 0, status: res.status, ms, reasons };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - start, reasons: [`injoignable : ${e.name === 'AbortError' ? 'timeout' : e.message}`] };
  } finally {
    clearTimeout(timer);
  }
}

function sslDaysLeft(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 10000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve(cert && cert.valid_to ? Math.floor((new Date(cert.valid_to) - new Date()) / 86400000) : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function discord(payload) {
  if (!WEBHOOK) { console.log('[pas de webhook configuré] alerte non envoyée'); return; }
  try {
    const r = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) console.log('Discord HTTP', r.status, (await r.text()).slice(0, 300));
  } catch (e) { console.log('Discord erreur', e.message); }
}

// --- Exécution des checks ---
const results = {};
for (const c of CONFIG.checks) results[c.name] = await runCheck(c);

const ssl = await sslDaysLeft(CONFIG.sslHost);
const sslOk = ssl === null ? true : ssl > (CONFIG.sslWarnDays || 14);

// --- Transitions d'état ---
const down = [], up = [], newState = {};
for (const c of CONFIG.checks) {
  const r = results[c.name];
  newState[c.name] = r.ok ? 'ok' : 'down';
  const was = prev[c.name] || 'ok';
  if (!r.ok && was === 'ok') down.push({ c, r });
  if (r.ok && was === 'down') up.push({ c, r });
}
newState.__ssl = sslOk ? 'ok' : 'warn';
const sslWas = prev.__ssl || 'ok';

const embeds = [];
if (down.length) embeds.push({
  title: '🔴 Japean — panne détectée',
  color: 15158332,
  description: down.map(({ c, r }) => `**${c.name}** — ${r.reasons.join(' · ')}\n${c.url}`).join('\n\n'),
  timestamp: iso(),
});
if (up.length) embeds.push({
  title: '🟢 Japean — rétabli',
  color: 3066993,
  description: up.map(({ c }) => `**${c.name}** OK\n${c.url}`).join('\n\n'),
  timestamp: iso(),
});
if (!sslOk && sslWas === 'ok') embeds.push({ title: '⚠️ Japean — certificat SSL bientôt expiré', color: 16776960, description: `Le certificat de ${CONFIG.sslHost} expire dans ${ssl} jours.`, timestamp: iso() });
if (sslOk && sslWas === 'warn') embeds.push({ title: '🟢 Japean — SSL renouvelé', color: 3066993, description: `Certificat de ${CONFIG.sslHost} de nouveau valide.`, timestamp: iso() });

if (embeds.length) await discord({ username: 'Japean Monitor', embeds });

fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2) + '\n');

// --- Résumé console ---
console.log('=== Japean monitor', iso(), '===');
for (const c of CONFIG.checks) {
  const r = results[c.name];
  console.log(`${r.ok ? 'OK ' : 'KO '} ${c.name.padEnd(26)} ${String(r.status).padStart(3)} ${String(r.ms).padStart(6)}ms ${r.reasons.join(' · ')}`);
}
console.log(`SSL ${CONFIG.sslHost}: ${ssl === null ? 'n/a' : ssl + ' j'}${sslOk ? '' : ' (ALERTE)'}`);
console.log(Object.values(results).some((r) => !r.ok) ? 'STATUT GLOBAL: DÉGRADÉ' : 'STATUT GLOBAL: OK');
