# RF SHOT — Coordinateur PMSE RF France
*by ARNISOUND TOOLS — LIVE & AV APP*

### 👉 [OUVRIR L'APPLICATION](https://arnisound.github.io/EASYRF/)

> ⚠️ L'application **n'est pas cette page**. Cette page (sur `github.com`) affiche
> seulement le code. Pour lancer l'app, clique sur le lien ci-dessus — il ouvre
> `arnisound.github.io/EASYRF/`, où se trouve le bouton « Analyser TNT ».

---

**RF SHOT** planifie les fréquences des liaisons HF (micros sans fil & oreillettes
IEM) en France, dans les bandes UHF autorisées au son (PMSE). À partir de la
couverture TNT réelle d'un lieu (données Arcom), il calcule un plan de
fréquences **sans conflit** : pas de TNT, pas d'intermodulation gênante entre
liaisons — puis l'exporte (feuille de scène, CSV, listes constructeur).

Application **100 % navigateur**, sans installation. Tout le calcul est local.

## Fonctionnalités

- **TNT localisée** — canaux UHF C21–C48 (470–694 MHz) occupés/libres à vos
  coordonnées, en direct depuis l'**Arcom (« Ma TNT »)** ; exclusion possible
  des émetteurs lointains par distance.
- **Catalogue multi-marque** (pro + amateur + **tournage cinéma**) : Shure,
  Sennheiser (dont SK 5212-II film), Sony, Audio-Technica, Wisycom,
  Lectrosonics, Sound Devices, Zaxcom, **Audio Ltd (A10)**, AKG, Mipro,
  beyerdynamic, the t.bone, LD Systems, Behringer, Prodipe, Sirus… + IEM.
  Bande **personnalisée** (saisie manuelle) et grille d'accord par modèle.
- **Coordination automatique** — placement optimisé (« packing ») qui range les
  produits d'intermodulation dans les canaux TNT occupés ou des canaux libres
  « sacrifiés », pour caser un **maximum de porteuses**. Optimisation par
  redémarrages multiples (best-of-N).
- **Intermodulation** : IM3 (2fA−fB), IM5 (3fA−2fB), 3TX (fA+fB−fC) et **IM7**
  (4fA−3fB, en option) — au-delà de la plupart des outils gratuits.
- **Score de fiabilité 0–5 ★** par liaison, basé sur une estimation de marge en
  dBc (modèle ; à valider sur site).
- **Import de scan** (Shure WWB, Sennheiser WSM, RF Explorer, tinySA…) — le plan
  évite automatiquement les pics et le bruit mesurés.
- **Modes Standard / Avancé** — Avancé : **groupes**, **coordination par zone**,
  garde IM réglable, fréquences réservées, placement manuel, prise en compte du
  **combiner IEM**.
- **Porteurs & feuille de scène** — affecter une personne/rôle à chaque liaison
  (« Jean – voix lead »), couleurs, réordonnancement, export d'une feuille de
  scène (PDF) avec porteur ↔ matériel ↔ fréquence/canal.
- **Projet** — Enregistrer / Ouvrir un projet complet (`.rfshot.json`),
  **Annuler / Rétablir**, menu Fichier.
- **Interopérabilité** — export CSV universel + listes de fréquences pour
  **Wireless Workbench** et **WSM**, et réimport d'un plan modifié.
- **Aide intégrée** — vulgarisation RF, définitions des IM, rôle de la TNT.

## Structure

```
EASYRF/
├── frontend/
│   ├── index.html      # l'application (autonome)
│   └── logo.svg        # logo RF SHOT
├── backend/            # proxy ANFR local optionnel (Node/Express)
├── relay/              # relais Deno (contourne le CORS Arcom en ligne)
└── lib/                # catalogue / utilitaires
```

## Source des données TNT

- `api-adresse.data.gouv.fr` — libellé de commune (informatif).
- `matnt.arcom.fr` — canaux TNT reçus au point demandé (station, multiplex,
  niveaux), appelé en direct depuis le navigateur, avec un **relais Deno** en
  secours si l'appel direct est bloqué (CORS).

Données : **Arcom** (ex-CSA) « Ma couverture TNT ».

## Déploiement (GitHub Pages)

1. Dépôt → **Settings → Pages**
2. **Source** : **GitHub Actions**
3. Le workflow `.github/workflows/pages.yml` publie le site à chaque push.

### Usage local (optionnel)

Ouvrir `frontend/index.html` dans le navigateur. Si les appels directs à l'Arcom
sont bloqués (CORS) et que vous ne voulez pas du relais Deno, lancer le proxy :

```bash
cd backend && npm install && node server.js   # → http://localhost:3001
```

## Avertissement

Aucun plan théorique n'est fiable à 100 % sans **test sur site** (émetteurs
allumés un par un, éclairages en service). RF SHOT fournit le meilleur point de
départ ; le terrain valide. Les niveaux dBc/étoiles sont **estimés par un
modèle**, pas mesurés.

## Licence

MIT
