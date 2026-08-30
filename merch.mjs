/**
 * Merchandising hebdo Japean — remplace le cron du panel OVH (jamais execute par
 * l'hebergeur, meme cause que la purge migree ici en juillet).
 *
 * Appelle l'endpoint web protege qui recalcule les scores v2.1 (ventes + paniers +
 * wishlist + vues Matomo via relais Google + saison + malus photos) et reapplique
 * les positions de toutes les categories. Poste le resultat sur Discord.
 */

const URL_MERCH = process.env.JAPEAN_MERCH_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const MATOMO_TOKEN = process.env.MATOMO_TOKEN || '';

// Les vues produit viennent de Matomo (stats.1-1.fr). Le runner GitHub y accede en direct
// (la prod OVH, elle, est bloquee en sortant). Best effort : sans vues, le score tourne
// avec le dernier fichier connu.
async function vuesMatomo() {
  if (!MATOMO_TOKEN) { console.log('vues: MATOMO_TOKEN absent'); return null; }
  try {
    const r = await fetch('https://stats.1-1.fr/index.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'JapeanMonitor/1.0 (+merch)' },
      body: new URLSearchParams({
        module: 'API', method: 'Actions.getPageUrls', idSite: '2',
        period: 'range', date: 'last90', format: 'JSON', flat: '1',
        filter_limit: '-1', token_auth: MATOMO_TOKEN,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (r.status !== 200) { console.log('vues: matomo HTTP ' + r.status); return null; }
    const rows = await r.json();
    if (!Array.isArray(rows)) { console.log('vues: reponse matomo inattendue'); return null; }
    const vues = {};
    for (const row of rows) {
      const m = /(?:^|\/)(\d+)(?:-\d+)?-[a-z0-9-]+\.html/.exec(String(row.label || ''));
      if (m) {
        const id = m[1];
        vues[id] = { u: (vues[id] ? vues[id].u : 0) + (Number(row.nb_visits) || 0) };
      }
    }
    const n = Object.keys(vues).length;
    console.log('vues: ' + n + ' produits mappes depuis Matomo');
    return n >= 50 ? vues : null;
  } catch (e) {
    console.log('vues: echec matomo : ' + e.message);
    return null;
  }
}

async function discord(embed) {
  if (!WEBHOOK) return console.log('[pas de webhook]');
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Japean Monitor', embeds: [embed] }),
  });
  console.log('discord -> HTTP ' + r.status);
}

if (!URL_MERCH) { console.error('JAPEAN_MERCH_URL manquant'); process.exit(1); }

let data = null;
let erreur = null;
try {
  const vues = await vuesMatomo();
  const r = await fetch(URL_MERCH, {
    method: 'POST',
    headers: { 'User-Agent': 'JapeanMonitor/1.0 (+merch)', 'Content-Type': 'application/json' },
    body: vues ? JSON.stringify(vues) : '',
    signal: AbortSignal.timeout(280000),
  });
  const texte = await r.text();
  if (r.status !== 200) erreur = 'HTTP ' + r.status + ' : ' + texte.slice(0, 200);
  else try { data = JSON.parse(texte); } catch { erreur = 'reponse illisible : ' + texte.slice(0, 200); }
} catch (e) {
  erreur = e.message;
}

if (erreur || !data || !data.ok) {
  await discord({
    title: 'Merchandising hebdo — ECHEC',
    description: (erreur || (data && data.err) || 'reponse vide').slice(0, 1000),
    color: 0xe74c3c,
    timestamp: new Date().toISOString(),
  });
  process.exit(1);
}

await discord({
  title: 'Merchandising hebdo — OK',
  description: (data.resume || []).join('\n').slice(0, 3900),
  color: 0x2ecc71,
  footer: { text: 'scores v2.1 : comportement + saison + photos — lundi 07h47 Paris' },
  timestamp: new Date().toISOString(),
});
console.log('merch OK');
