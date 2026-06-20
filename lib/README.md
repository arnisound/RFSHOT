# RF SHOT — modules réutilisables

Modules ES autonomes (zéro dépendance, zéro DOM) extraits de RF SHOT, pour
réutiliser dans un autre projet (artefact, app, script Node…) :

| Fichier | Rôle |
|---|---|
| `rfshot-tnt.js` | **API données** — interroge l'API publique Arcom « Ma couverture TNT » et renvoie la grille des canaux UHF occupés/libres. |
| `rfshot-scan.js` | **Import scans** — parse les exports CSV de scan de spectre (Shure WWB, Sennheiser WSM, RF Explorer, tinySA…) avec auto-détection du format. |
| `rfshot-coordination.js` | **Moteur** — plan auto rapide & fiable : packing IM (IM3/IM5/IM7 + 3TX dirigés vers la TNT occupée / canaux sacrifiés), score de fiabilité en dBc, optimisation best-of-N. |
| `rfshot-catalog.js` | **Base de données** — micros HF / IEM utilisés en France (16 marques micros / 53 modèles + 10 marques IEM / 25 modèles), du tournage cinéma (Audio Ltd A10, Sennheiser SK 5212-II…) à l'amateur (the t.bone, LD Systems, Behringer, Prodipe, Sirus…), avec espacement (sp) et pas d'accord (st). 2,4 GHz exclu. |
| `rfshot-relay.ts` | Relais CORS optionnel (Deno Deploy) si l'appel direct navigateur est bloqué. |

Compatibles navigateur (ESM) et Node ≥ 18 (`fetch`/`AbortSignal.timeout` natifs).

---

## 1. Récupérer la couverture TNT

```js
import { getTNT, applyExclusion, distKm } from './rfshot-tnt.js';

const { channels, source_label } = await getTNT(43.6105, 3.8705);
// channels : [{ ch, freq_start, freq_end, occupied, pmse, mux, station,
//               sta_lat, sta_lng, level_dbm, emitters, ... }, ...]

// Optionnel : ignorer les émetteurs à plus de 60 km (libère des canaux)
const ignored = applyExclusion(channels, 43.6105, 3.8705, 60);
```

`getTNT(lat, lon, opts)` :
- `opts.relay` — URL d'un relais CORS (un défaut public est fourni ; `null` pour désactiver).
- `opts.reverseGeocode` — résoudre le nom de commune via `api-adresse.data.gouv.fr` (défaut `true`).

> ⚠️ Depuis un navigateur, l'appel direct à `matnt.arcom.fr` est souvent bloqué
> par CORS. Déployez `rfshot-relay.ts` sur Deno Deploy et passez son URL via
> `opts.relay`. En Node, l'appel direct fonctionne sans relais.

## 2. Coordonner les fréquences

```js
import { autoPlan, generatePlan, applyPlan, computeIM } from './rfshot-coordination.js';
import { toMic, IEM_CATALOG } from './rfshot-catalog.js';

// Liaisons : depuis le catalogue (toMic) ou à la main { fmin, fmax, spacing }.
const mics = [
  toMic('Shure', 'Axient Digital', 0, { name: 'Lead' }),     // micro
  toMic('Sennheiser', '2000 IEM', 2, { name: 'IEM 1', kind: 'iem' }, IEM_CATALOG),
  { name: 'Libre', fmin: 470, fmax: 534, spacing: 350 },     // ou à la main
];

// Plan AUTO (recommandé) : packing + best-of-N, retient le meilleur plan.
const plan = autoPlan(mics, channels);
applyPlan(mics, plan);                 // écrit mic.freq pour les placés
// plan = { placed[], freqs[], nOK, nKO, mode:'std'|'adv'|'max', seed,
//          reliab:{ grade, dbc, marginKHz, res2, res3, value }, imTV, imFree, sacr }
console.log(`${plan.nOK}/${mics.length} · ${plan.reliab.grade} · ${plan.reliab.dbc} dBc`);

// Contrôle fin de generatePlan(mics, channels, opts) :
generatePlan(mics, channels, { mode: 'rob' });           // robuste (ajoute l'IM7)
generatePlan(mics, channels, { coord: { txDist: 'tight', iemNoCombiner: true } });
generatePlan(mics, channels, { scanSpans: [[600, 605]] });   // zones d'un scan à éviter
generatePlan(mics, channels, { reserved: [486.5] });         // fréquences à éviter partout
generatePlan(mics, channels, { shuffle: true, seed: 7 });    // tirage reproductible
```

Inspecter les produits d'intermodulation d'un jeu de fréquences :

```js
const im = computeIM([495.5, 500.0, 510.3], { im7: true });
// [{ ord, kind:'IM3'|'IM5'|'3TX'|'IM7', freq, src:[i,j(,k)] }, …]
```

Audit des intermodulations d'un plan fini :

```js
const hits = imHitsPerCarrier(placed.filter(Boolean));
// [{ idx, freq, im2:[...], im3:[...] }, ...]  im2 = produits critiques
```

## 3. Base de données micros / IEM

```js
import { MIC_CATALOG, IEM_CATALOG, listBrands, listModels,
         getModel, flatten, toMic } from './rfshot-catalog.js';

listBrands();                       // ['Shure','Sennheiser','Sony', …] (16 marques)
listModels('Shure');                // ['Axient Digital','ULX-D','QLX-D', …]
getModel('Shure', 'ULX-D');         // { sp:350, b:[['G51',470,534], …] }

// Construire un micro prêt pour generatePlan() : marque, modèle, index de gamme
const mic = toMic('Shure', 'ULX-D', 0, { name: 'HH 1' });
// → { brand:'Shure', model:'ULX-D', band:'G51', fmin:470, fmax:534, spacing:350, name:'HH 1' }

// Toutes les gammes à plat (124 entrées micros)
flatten(MIC_CATALOG);  // [{ brand, model, band, fmin, fmax, spacing }, …]
flatten(IEM_CATALOG);  // idem pour les retours in-ear
```

Structure brute : `marque → modèle → { sp:<espacement kHz>, b:[[libellé, fmin, fmax], …] }`.
Marques incluses : Shure, Sennheiser, Sony, Audio-Technica, Wisycom, Lectrosonics,
Sound Devices, Zaxcom, AKG, Mipro, beyerdynamic, the t.bone, LD Systems, Røde, DJI.

> Les gammes sont indicatives (déclinaisons EU courantes) ; vérifiez la bande
> exacte de votre matériel avant exploitation.

## 4. Importer un scan de spectre

```js
import { parseScan, binToChannels } from './rfshot-scan.js';

// CSV exporté par Shure Wireless Workbench, Sennheiser WSM, RF Explorer,
// tinySA, Lectrosonics Wireless Designer, etc. — un seul parseur les couvre.
const { points, meta, warnings } = parseScan(await file.text());
// points : [{ f, db }, …]  f en MHz, db en dBm, trié par fréquence
// meta   : { delimiter, decimal, unit, swapped, count, fmin, fmax, dbMin, dbMax, … }

// Reporter le niveau mesuré sur la grille TNT (champs scan_dbm / scan_occupied)
const { occupied } = binToChannels(points, channels, { threshold: -85 });
```

`parseScan()` auto-détecte le **délimiteur** (`,` `;` tab `|` espace), le **séparateur
décimal** (`.`/`,`), l'**unité** (Hz/kHz/MHz), l'ordre des colonnes et saute le
préambule/en-tête. Forçage possible : `parseScan(text, { delimiter, decimal, unit })`.
Formats couverts : tous ceux qui exportent un CSV `(fréquence, amplitude dBm)`
— soit la quasi-totalité des logiciels constructeur et analyseurs de spectre.

---

## Notes techniques

- **Fréquences en MHz, espacement en kHz.** L'espacement par modèle (`spacing`)
  sert d'écart minimal entre porteuses voisines.
- **IM 2 tons** (`2fA−fB`, `3fA−2fB`) : les plus fortes → jamais sur une porteuse
  (contrainte dure, garde 150 kHz).
- **IM 3 tons** (`fA+fB−fC`) : croissent en n³ ; minimisées, tolérées au-delà de
  la capacité (≈ 25-30 micros sur la seule bande TNT).
- **IM5 3 sources** : prises en compte uniquement en mode `advanced`.
- Les IM sont poussées en priorité dans les **canaux TV occupés** (sans gêne) ;
  à défaut, l'algo « sacrifie » quelques canaux libres (`stats.sacrificed`) pour
  y concentrer les IM résiduelles plutôt que de polluer tout le spectre.
- `PLAN_BANDS` définit les bandes légales françaises (TNT 470-694, PMSE 823-832,
  863-865, 1785-1805, 2.4 GHz). Adaptez ce tableau pour un autre pays.
- Performance : masques `Uint8Array` (25 kHz/cellule) ⇒ contrôles IM en O(1).
  Un plan de 50 micros se calcule en < 1 s.
