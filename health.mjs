/**
 * Bilan sante hebdomadaire Japean (bloc A de CHECKLIST-AUDIT-TECH.md, repo Japean local).
 *
 * Chaque lundi : verifie le front (home/sitemap/robots + temps de reponse), appelle
 * l'endpoint sante de la prod (JSON, jeton), applique les seuils vert/orange/rouge
 * et poste TOUJOURS le bilan sur Discord (vert = on sait que ca tourne).
 */

const URL_HEALTH = process.env.JAPEAN_HEALTH_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const UA = { 'User-Agent': 'JapeanMonitor/1.0 (+health)' };

const alertes = [];   // rouge
const avert = [];     // orange
const lignes = [];    // corps du bilan

async function discord(embed) {
  if (!WEBHOOK) return console.log('[pas de webhook]');
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Japean Monitor', embeds: [embed] }),
  });
  console.log('discord -> HTTP ' + r.status);
}

// --- 1. Front ---
for (const [nom, url] of [
  ['home', 'https://www.japean.com/'],
  ['sitemap', 'https://www.japean.com/sitemap.xml'],
  ['robots', 'https://www.japean.com/robots.txt'],
]) {
  const t0 = Date.now();
  let code = 0;
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
    code = r.status;
    await r.arrayBuffer();
  } catch (e) { code = 0; }
  const s = (Date.now() - t0) / 1000;
  if (code !== 200) alertes.push(nom + ' repond HTTP ' + code);
  else if (nom === 'home' && s > 4) alertes.push('home lente : ' + s.toFixed(1) + ' s');
  else if (nom === 'home' && s > 2) avert.push('home un peu lente : ' + s.toFixed(1) + ' s');
  if (nom === 'home') lignes.push('Front : HTTP ' + code + ' en ' + s.toFixed(1) + ' s');
}

// --- 2. Endpoint sante prod ---
let d = null;
try {
  const r = await fetch(URL_HEALTH, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  d = await r.json();
} catch (e) {
  alertes.push('endpoint sante injoignable : ' + e.message);
}

if (d) {
  // Base
  if (d.db_pct > 70) alertes.push('base a ' + d.db_pct + ' % du quota -> purger (DROP+CREATE)');
  else if (d.db_pct >= 50) avert.push('base a ' + d.db_pct + ' % du quota');
  lignes.push('Base : ' + d.db_mo + ' Mo (' + d.db_pct + ' %)');
  // Erreurs
  if (d.erreurs_7j > 50) alertes.push(d.erreurs_7j + ' erreurs en 7 j - top : ' + (d.erreur_top || '?'));
  else if (d.erreurs_7j > 5) avert.push(d.erreurs_7j + ' erreurs en 7 j - top : ' + (d.erreur_top || '?'));
  lignes.push('Erreurs 7 j : ' + d.erreurs_7j + ' | 404 : ' + d.nf404_7j);
  // Emails
  if (d.repli_gmail > 0) avert.push('repli Gmail : ' + d.repli_gmail + ' lignes (OAuth a verifier)');
  lignes.push('Emails 7 j : ' + d.mails_7j + ' | repli Gmail : ' + d.repli_gmail);
  // Commandes
  if (d.commandes_14j === 0) alertes.push('ZERO commande en 14 j -> tester le tunnel');
  else if (d.commandes_7j === 0) avert.push('aucune commande cette semaine');
  lignes.push('Commandes : ' + d.commandes_7j + ' (7 j) / ' + d.commandes_14j + ' (14 j)');
  // Catalogue
  const c = d.corrompus || {};
  if (c.ps_shop_zero > 0 || c.cache_attr_actifs > 0 || c.desc_null_lang1 > 0) {
    alertes.push('corruptions produit : ps_shop=' + c.ps_shop_zero + ' cache_attr=' + c.cache_attr_actifs + ' descNULL=' + c.desc_null_lang1);
  }
  lignes.push('Catalogue : ' + d.produits_actifs + ' actifs, ' + d.actifs_sans_stock + ' sans stock');
  // Tables de logs (purge quotidienne efficace ?)
  const t = d.tables || {};
  if (t.connections > 100000 || t.guest > 100000) avert.push('tables tracking regonflent (connections=' + t.connections + ')');
}

// --- 3. Verdict + Discord ---
const statut = alertes.length ? ['ROUGE', 0xe74c3c] : avert.length ? ['ORANGE', 0xe67e22] : ['VERT', 0x2ecc71];
let desc = lignes.join('\n');
if (avert.length) desc = '**A surveiller :**\n' + avert.map(a => '- ' + a).join('\n') + '\n\n' + desc;
if (alertes.length) desc = '**Alertes :**\n' + alertes.map(a => '- ' + a).join('\n') + '\n\n' + desc;

await discord({
  title: 'Bilan sante hebdo japean.com - ' + statut[0],
  description: desc.slice(0, 3900),
  color: statut[1],
  footer: { text: 'bloc A de CHECKLIST-AUDIT-TECH.md - lundi 07h33 Paris' },
  timestamp: new Date().toISOString(),
});

console.log('statut : ' + statut[0]);
if (alertes.length) process.exit(1); // le run GitHub apparait en echec si rouge
