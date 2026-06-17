// Vérificateur de disponibilité Japean — HTTP + mot-clé positif/négatif + SSL + latence.
// Alerte Discord enrichie : type de panne, cause probable, piste, extrait d'erreur de la page.
// Alerte uniquement sur transition (panne / rétablissement). Aucune dépendance externe.
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
const norm = (s) => s.replace(/ | /g, ' '); // espaces insécables PrestaShop

// Cause probable + piste selon le type d'échec (adapté aux incidents connus Japean).
function diagnose(cls) {
  switch (cls) {
    case '5xx':   return ['Erreur serveur (500/502)', 'Si plusieurs pages touchées → cache `var/` ou base de données. Si une seule fiche → combinaison / cache_default_attribute / pa_shop.id_product=0.'];
    case '503':   return ['Service indisponible (503)', 'Mode maintenance activé par erreur, OU surcharge serveur (voir Retry-After).'];
    case '404':   return ['Page introuvable (404)', 'Produit/catégorie désactivé ou supprimé, ou URL modifiée.'];
    case 'timeout': return ['Aucune réponse (timeout)', 'Serveur down ou saturé (OVH mutualisé), ou requête bloquée.'];
    case 'conn':  return ['Connexion impossible', 'DNS, certificat SSL, ou réseau / pare-feu.'];
    case 'blank': return ['Page blanche (200 mais contenu manquant)', 'Erreur PHP silencieuse ou OPcache servant du code obsolète — purger le cache OVH.'];
    case 'errstr':return ['Message d\'erreur dans la page', 'Exception PHP, page de maintenance, ou base de données injoignable.'];
    case 'price0':return ['Prix 0 € sur une tuile', 'cache_default_attribute corrompu pointant vers une autre combinaison, ou groupe de taxe à 0.'];
    case 'slow':  return ['Lenteur (TTFB élevé)', 'Surcharge, cache froid, ou requête SQL lente.'];
    default:      return ['Cause indéterminée', 'Voir le détail ci-dessous.'];
  }
}

async function runCheck(c) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(c.url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'JapeanMonitor/1.1 (+uptime)' } });
    const body = norm(await res.text());
    const ms = Date.now() - start;
    const reasons = [];
    let cls = null;
    if (c.expectStatus && res.status !== c.expectStatus) { reasons.push(`HTTP ${res.status} (attendu ${c.expectStatus})`); cls = res.status === 503 ? '503' : res.status >= 500 ? '5xx' : res.status === 404 ? '404' : 'http'; }
    for (const kw of c.mustContain || []) if (!body.includes(norm(kw))) { reasons.push(`manque « ${kw} »`); cls = cls || 'blank'; }
    for (const kw of c.mustNotContain || []) if (body.includes(norm(kw))) { reasons.push(`contient « ${kw} »`); cls = cls || 'errstr'; }
    for (const rx of c.mustNotMatch || []) if (new RegExp(rx).test(body)) { reasons.push('prix 0 € sur une tuile'); cls = cls || 'price0'; }
    if (ms > LAT_WARN) { reasons.push(`lenteur ${(ms / 1000).toFixed(1)} s`); cls = cls || 'slow'; }
    // Extrait d'erreur éventuel dans la page (origine).
    let snippet = null;
    const em = body.match(/(Fatal error|Uncaught|PrestaShop\w*Exception|Exception thrown|Service Unavailable|maintenance|Whoops|Link to database|Cannot connect to|Allowed memory size)[^<\n]{0,140}/i);
    if (em) snippet = em[0].replace(/\s+/g, ' ').trim().slice(0, 170);
    return { ok: reasons.length === 0, status: res.status, ms, reasons, cls, snippet, server: res.headers.get('server'), retry: res.headers.get('retry-after') };
  } catch (e) {
    const to = e.name === 'AbortError';
    return { ok: false, status: 0, ms: Date.now() - start, reasons: [to ? 'timeout (aucune réponse)' : `injoignable : ${e.message}`], cls: to ? 'timeout' : 'conn', snippet: null };
  } finally { clearTimeout(timer); }
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

// Construit un champ Discord détaillé par page en panne.
function downField(c, r) {
  const [cause, piste] = diagnose(r.cls);
  let v = `${r.reasons.join(' · ')}\n🔎 **Cause probable :** ${cause}`;
  if (r.retry) v += ` (Retry-After: ${r.retry})`;
  v += `\n🛠️ **Piste :** ${piste}`;
  if (r.snippet) v += `\n📄 *Extrait page :* \`${r.snippet}\``;
  v += `\n${c.url}`;
  return { name: `❌ ${c.name} ${r.status ? '(' + r.status + ')' : ''}`, value: v.slice(0, 1024) };
}

// Diagnostic global selon l'étendue.
function globalDiag(downChecks, results) {
  const accueilDown = downChecks.some((d) => /accueil/i.test(d.c.name));
  const allServer = downChecks.every((d) => ['5xx', '503', 'timeout', 'conn'].includes(d.r.cls));
  const downCount = downChecks.length;
  const total = Object.keys(results).length;
  if ((accueilDown || downCount >= Math.ceil(total / 2)) && allServer) return '🌐 **Panne globale probable** — tout le site semble touché (cache `var/`, base de données, ou serveur OVH down).';
  if (downChecks.every((d) => /fiche|panier|back-office/i.test(d.c.name))) return '🎯 **Problème localisé** — l\'accueil répond, seules certaines pages échouent.';
  return '⚠️ **Problème partiel** — une partie des pages est touchée.';
}

// --- Mode TEST : envoie un exemple d'alerte détaillée puis sort (pas de modif d'état). ---
if (process.env.TEST_ALERT === '1') {
  const demoDown = [
    { c: { name: 'Fiche Carpe Koi', url: 'https://www.japean.com/kimonos-homme/4390-16696-kimono-homme-carpe-koi.html' }, r: { status: 500, reasons: ['HTTP 500 (attendu 200)'], cls: '5xx', snippet: 'PrestaShopException: Property Product->isbn is not valid', retry: null } },
    { c: { name: 'Categorie kimonos homme', url: 'https://www.japean.com/158-kimonos-homme' }, r: { status: 200, reasons: ['prix 0 € sur une tuile'], cls: 'price0', snippet: null, retry: null } },
  ];
  await discord({
    username: 'Japean Monitor',
    embeds: [{
      title: '🔴 [EXEMPLE/TEST] Japean — panne détectée',
      color: 15158332,
      description: '🎯 **Problème localisé** — exemple de rapport détaillé (ceci est un test, le site va bien).',
      fields: demoDown.map(({ c, r }) => downField(c, r)),
      timestamp: iso(),
    }],
  });
  console.log('Alerte de TEST envoyée.');
  process.exit(0);
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
  description: globalDiag(down, results),
  fields: down.map(({ c, r }) => downField(c, r)),
  timestamp: iso(),
});
if (up.length) embeds.push({
  title: '🟢 Japean — rétabli',
  color: 3066993,
  description: up.map(({ c }) => `**${c.name}** de nouveau OK\n${c.url}`).join('\n\n'),
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
