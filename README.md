# japean-uptime

Surveillance autonome et gratuite de [japean.com](https://www.japean.com) via GitHub Actions.

Toutes les 5 minutes, un job vérifie les pages clés de la boutique :
code HTTP attendu + présence d'un texte attendu + **absence** de signaux de panne
(`0,00 €`, `Fatal error`, page blanche, maintenance), latence et expiration du certificat SSL.

En cas de **panne** (ou de **rétablissement**), une alerte est envoyée sur Discord.
Une alerte n'est envoyée que sur **changement d'état** (pas de spam tant que la panne dure).

## Pages surveillées

Définies dans [`checks.json`](checks.json) : accueil, catégorie kimono, deux fiches
produit, panier et back-office. Modifier ce fichier pour ajuster URLs et mots-clés.

## Configuration

Un seul secret de dépôt requis (Settings → Secrets and variables → Actions) :

- `DISCORD_WEBHOOK_URL` — URL du webhook Discord recevant les alertes.

Sans ce secret, le job tourne quand même et journalise le statut, mais n'envoie rien.

## Limites assumées

- Cadence *best-effort* GitHub Actions (retard possible de quelques minutes).
- Si GitHub Actions est lui-même en panne, aucune alerte ne part → ce dépôt est
  **doublé** par un moniteur externe indépendant (BetterStack).

Test manuel : onglet **Actions** → *Japean uptime* → **Run workflow**.
