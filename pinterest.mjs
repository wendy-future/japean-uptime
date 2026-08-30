/**
 * Regeneration quotidienne du flux catalogue Pinterest de Japean.
 *
 * Contexte : les crons du panel OVH ne sont jamais executes par l'hebergeur — le flux
 * etait fige depuis sa creation manuelle du 25/08 (constate le 30/08 : 5 jours de retard).
 * Meme cause et meme remede que la purge et le merchandising, deja migres ici.
 *
 * Le script appelle un endpoint protege par jeton cote PrestaShop, qui rejoue
 * maintenance/pinterest_feed.php et reecrit www/pinterest-catalog.csv.
 * Aucune donnee metier n'est modifiee : le flux est une simple projection du catalogue.
 */

const URL_PIN = process.env.JAPEAN_PINTEREST_URL;
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
// Le catalogue tourne autour de 870 produits actifs ; sous 500 lignes, c'est qu'une partie
// du catalogue a disparu du flux (bug de generation ou desactivation massive).
const SEUIL_PRODUITS = 500;

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

if (!URL_PIN) {
  console.error('JAPEAN_PINTEREST_URL manquant');
  process.exit(1);
}

const t0 = Date.now();
let data = null;
let httpStatus = 0;
let erreur = null;

try {
  const r = await fetch(URL_PIN, { method: 'POST', signal: AbortSignal.timeout(290000) });
  httpStatus = r.status;
  const txt = await r.text();
  try { data = JSON.parse(txt); } catch { erreur = 'reponse illisible : ' + txt.slice(0, 200); }
} catch (e) {
  erreur = e.message;
}

const duree = Math.round((Date.now() - t0) / 1000);
const produits = data && data.produits ? data.produits : 0;
const ok = !erreur && httpStatus === 200 && data && data.ok === true && produits >= SEUIL_PRODUITS;

console.log(`[${iso()}] HTTP ${httpStatus} | produits=${produits} | regenere=${data?.csv_regenere} | ${duree}s`);
if (data?.sortie) console.log('sortie : ' + data.sortie);
if (erreur) console.log('erreur : ' + erreur);

await discord({
  title: ok ? 'Flux Pinterest regenere' : 'Flux Pinterest — echec',
  color: ok ? 0x2ecc71 : 0xe74c3c,
  description: ok
    ? `${produits} produits dans le flux (${data.taille_ko} Ko), genere en ${duree}s.`
    : `HTTP ${httpStatus}${erreur ? ' — ' + erreur : ''}${data && !data.ok ? ' — ' + (data.err || 'csv non regenere') : ''}${produits && produits < SEUIL_PRODUITS ? ` — seulement ${produits} produits (seuil ${SEUIL_PRODUITS})` : ''}`,
  timestamp: iso(),
});

process.exit(ok ? 0 : 1);
