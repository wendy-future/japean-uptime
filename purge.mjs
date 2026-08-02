/**
 * Purge quotidienne de la base Japean.
 *
 * Contexte : le cron du panel OVH est désactivé côté hébergeur et nos relances n'ont
 * rien donné. Sans entretien, les tables de tracking regonflent d'environ 150 Mo/jour
 * et l'on repasse sous le plafond caché `max_questions = 40 000 req/h` — c'est ce qui
 * provoquait les erreurs 500 en rafale.
 *
 * Ce script appelle un endpoint protégé par jeton côté PrestaShop, qui vide les tables
 * de logs et le cache de filtres. Aucune donnée métier n'est touchée.
 */

const URL_PURGE = process.env.JAPEAN_PURGE_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
// En régime normal la base tient à ~202 Mo et ne croît plus (mesuré le 01/08, source
// du gonflement = un crawler externe, depuis bloqué). 400 Mo signale donc une reprise
// du bombardement bien avant que ça devienne critique.
const SEUIL_ALERTE_MO = 400;

const iso = () => new Date().toISOString();

async function discord(embed) {
  if (!WEBHOOK) return console.log('[pas de webhook] notification non envoyée');
  try {
    const r = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Japean Monitor', embeds: [embed] }),
    });
    console.log('discord → HTTP ' + r.status);
  } catch (e) {
    console.log('discord → échec : ' + e.message);
  }
}

if (!URL_PURGE) {
  console.error('JAPEAN_PURGE_URL manquant');
  process.exit(1);
}

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 280000);

let data = null;
let erreur = null;

try {
  const res = await fetch(URL_PURGE, {
    signal: ctrl.signal,
    headers: { 'User-Agent': 'JapeanMonitor/1.0 (+purge)' },
  });
  const texte = await res.text();
  if (res.status !== 200) {
    erreur = 'HTTP ' + res.status;
  } else {
    try {
      data = JSON.parse(texte);
    } catch {
      erreur = 'réponse illisible : ' + texte.slice(0, 200);
    }
  }
} catch (e) {
  erreur = e.name === 'AbortError' ? 'délai dépassé' : e.message;
} finally {
  clearTimeout(timer);
}

if (erreur || !data || data.ok !== true) {
  const motif = erreur || (data && data.error) || 'réponse inattendue';
  console.error('purge en échec : ' + motif);
  await discord({
    title: '⚠️ Japean — la purge de base a échoué',
    color: 15158332,
    description:
      "La purge quotidienne n'a pas pu s'exécuter : **" + motif + '**.\n' +
      'Sans elle, la base regonfle et les erreurs 500 finissent par revenir.',
    timestamp: iso(),
  });
  process.exit(1);
}

if (data.skipped) {
  console.log('purge ignorée (' + data.skipped + ')');
  process.exit(0);
}

console.log(
  `purge OK : ${data.avant_mo} → ${data.apres_mo} Mo ` +
  `(${data.gagne_mo} Mo libérés, ${data.paniers} paniers, ${data.duree_s}s)`
);
for (const d of data.detail || []) console.log('  - ' + d);

// Notification quotidienne uniquement si quelque chose mérite l'attention.
if (data.apres_mo > SEUIL_ALERTE_MO) {
  await discord({
    title: '⚠️ Japean — base toujours volumineuse après purge',
    color: 16776960,
    description:
      `La base pèse encore **${data.apres_mo} Mo** après la purge ` +
      `(${data.avant_mo} Mo avant, ${data.gagne_mo} Mo libérés).\n` +
      `Au-delà de ${SEUIL_ALERTE_MO} Mo, le ménage ne suffit plus : il y a autre chose à regarder.`,
    timestamp: iso(),
  });
}
