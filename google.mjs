/**
 * Regeneration quotidienne du flux Google Shopping (Merchant Center) de Japean.
 *
 * Meme rail que le flux Pinterest : un endpoint protege par jeton cote PrestaShop rejoue
 * maintenance/google_feed.php et reecrit www/google-shopping.csv (une ligne par declinaison
 * en stock). Merchant Center recupere ensuite le CSV a heure fixe. Aucune donnee metier
 * n'est modifiee : le flux est une projection du catalogue.
 */

const URL_GOOGLE = process.env.JAPEAN_GOOGLE_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
// ~2 200 declinaisons en stock au lancement (09/09/2026). Sous 1 000 lignes, une partie du
// catalogue a disparu du flux (bug de generation ou rupture massive) : on alerte.
const SEUIL_LIGNES = 1000;

const iso = () => new Date().toISOString();

async function discord(embed) {
  if (!WEBHOOK) return console.log('[pas de webhook] notification non envoyee');
  try {
    const r = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Japean Monitor', embeds: [embed] }),
    });
    console.log('discord -> HTTP ' + r.status);
  } catch (e) {
    console.log('discord -> echec : ' + e.message);
  }
}

if (!URL_GOOGLE) {
  console.error('JAPEAN_GOOGLE_URL manquant');
  process.exit(1);
}

const t0 = Date.now();
let data = null;
let httpStatus = 0;
let erreur = null;

try {
  // User-Agent identifie : sans lui, Cloudflare sert un challenge au runner GitHub.
  const r = await fetch(URL_GOOGLE, {
    method: 'POST',
    headers: { 'User-Agent': 'JapeanMonitor/1.0 (+google-shopping)' },
    signal: AbortSignal.timeout(290000),
  });
  httpStatus = r.status;
  const txt = await r.text();
  try { data = JSON.parse(txt); } catch { erreur = 'reponse illisible : ' + txt.slice(0, 200); }
} catch (e) {
  erreur = e.message;
}

const duree = Math.round((Date.now() - t0) / 1000);
const lignes = data && data.lignes ? data.lignes : 0;
const ok = !erreur && httpStatus === 200 && data && data.ok === true && lignes >= SEUIL_LIGNES;

console.log(`[${iso()}] HTTP ${httpStatus} | lignes=${lignes} | regenere=${data?.csv_regenere} | ${duree}s`);
if (data?.sortie) console.log('sortie : ' + data.sortie);
if (erreur) console.log('erreur : ' + erreur);

await discord({
  title: ok ? 'Flux Google Shopping regenere' : 'Flux Google Shopping — echec',
  color: ok ? 0x2ecc71 : 0xe74c3c,
  description: ok
    ? `${lignes} declinaisons en stock dans le flux (${data.taille_ko} Ko), genere en ${duree}s.`
    : `HTTP ${httpStatus}${erreur ? ' — ' + erreur : ''}${data && !data.ok ? ' — ' + (data.err || 'csv non regenere') : ''}${lignes && lignes < SEUIL_LIGNES ? ` — seulement ${lignes} lignes (seuil ${SEUIL_LIGNES})` : ''}`,
  timestamp: iso(),
});

process.exit(ok ? 0 : 1);
