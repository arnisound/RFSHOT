// rfshot-coordination.js — Moteur de coordination de fréquences RF SHOT
// =============================================================================
// Extrait de RF SHOT (by Arnisound Tools). Aucune dépendance, aucun DOM.
// Calcule un plan de fréquences micros / IEM sans conflit : évite la TNT, les
// zones bruitées d'un scan, et concentre les produits d'intermodulation (IM)
// dans les canaux TV occupés ou quelques canaux libres « sacrifiés » (packing)
// pour caser un maximum de porteuses.
//
//   import { autoPlan, generatePlan, applyPlan, snapFreq } from './rfshot-coordination.js';
//   import { toMic } from './rfshot-catalog.js';
//
//   const mics = [ toMic('Shure','Axient Digital',0,{name:'Lead'}), ... ];
//   const channels = (await getTNT(lat, lon)).channels;   // cf. rfshot-tnt
//   const plan = autoPlan(mics, channels);                // plan auto rapide & fiable
//   applyPlan(mics, plan);                                 // écrit mic.freq
//   console.log(plan.nOK + '/' + mics.length, plan.reliab.grade, plan.reliab.dbc + ' dBc');
//
// Conventions :
//   - fréquences en MHz, spacing en kHz, tuneStep (pas d'accord) en kHz ;
//   - un « canal » TNT : { freq_start, freq_end, occupied } (cf. rfshot-tnt) ;
//   - un « micro » : { fmin, fmax, spacing, tuneStep?, bw?, kind?, freq?, locked? }.
//
// Idée directrice : les IM 2 tons (IM3 2fA−fB, IM5 3fA−2fB) sont les plus fortes
// et ne tombent JAMAIS sur une porteuse (contrainte dure). Les 3TX (fA+fB−fC) et
// l'IM7 (4fA−3fB) sont plus faibles : minimisés/packés. Le score de fiabilité
// estime la marge du pire produit en dBc (modèle — à valider sur site).

// Bandes légalement exploitables pour les micros HF en France (MHz).
export const PLAN_BANDS = [[470, 694], [822, 838], [863, 865], [1785, 1805], [2400, 2483.5]];

// ── Masques de fréquences : 1 cellule = 25 kHz, marquage ± garde, test O(1) ──
const FGRID = 40; // cellules par MHz
const maskNew = () => new Uint8Array(Math.round(2500 * FGRID));
function maskMark(mask, f, half) {
  const c = Math.round(f * FGRID), h = Math.round(half * FGRID);
  for (let i = Math.max(0, c - h), e = Math.min(mask.length - 1, c + h); i <= e; i++) mask[i] = 1;
}
const maskHit = (mask, f) => mask[Math.round(f * FGRID)] === 1;

// ── Garde IM (MHz) selon la distance émetteurs / surcharge manuelle ──────────
const DIST_GUARD = { tight: 0.22, near: 0.15, far: 0.07 };   // serrés / ~2 m / éloignés
const GUARD_MODE = { tight: 0.08, normal: 0.15, large: 0.22 };
function guardMHzOf(c) {
  const gm = c.guardMode || 'auto';
  if (gm !== 'auto' && GUARD_MODE[gm] != null) return GUARD_MODE[gm];
  return DIST_GUARD[c.txDist || 'near'];
}

// ── Modèle de niveau IM approximatif (dBc sous la porteuse) ──────────────────
const IM_DBC = { im3: 0, im5: -12, im7: -22, tx3: -6, tx5: -18 };
const TXDIST_DBC = { tight: 6, near: 0, far: -10 };           // couplage selon distance émetteurs
const IEM_COMBINER_DBC = -15;   // IEM↔IEM via combiner : intermod fortement réduite
const IEM_RACK_DBC = 6;         // IEM↔IEM en rack SANS combiner : pire cas
const IM_RES_SLOPE = 400;       // réjection FI du récepteur hors bande (dB/MHz)
const txDistDbcOf = c => TXDIST_DBC[c.txDist || 'near'] || 0;
const coupleDbcOf = (c, allIEM) => allIEM ? (c.iemNoCombiner ? IEM_RACK_DBC : IEM_COMBINER_DBC) : txDistDbcOf(c);
const imEffDbc = (base, d, half, off) => base + off - (d <= half ? 0 : (d - half) * IM_RES_SLOPE);

const DEFAULT_COORD = { txDist: 'near', guardMode: 'auto', iemNoCombiner: false };

// RNG déterministe (mulberry32) : rejoue exactement un tirage best-of-N via sa graine.
export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Aligne une fréquence sur la grille d'accord réelle du modèle (défaut 25 kHz). */
export function snapFreq(m, f) {
  const step = Math.max(0.005, (m.tuneStep || 25) / 1000);
  const v = m.fmin + Math.round((f - m.fmin) / step) * step;
  return parseFloat(Math.max(m.fmin, Math.min(m.fmax, v)).toFixed(3));
}

/**
 * Calcule un plan de fréquences pour un sous-ensemble de liaisons.
 * @param {Array} mics      liaisons { fmin, fmax, spacing, tuneStep?, bw?, kind?, freq?, locked? }
 * @param {Array} channels  canaux TNT { freq_start, freq_end, occupied }
 * @param {Object} [opts]   { mode:'std'|'adv'|'rob'|'max', coord:{txDist,guardMode,iemNoCombiner},
 *                            scanSpans:[[lo,hi]], exclSpans:[[lo,hi]], fixed:[{freq,sp}],
 *                            reserved:[freq], shuffle, seed }
 * @returns stats { placed[], freqs[], nOK, nKO, reliab:{grade,dbc,marginKHz,value,...}, res3, res5, imTV, imFree, sacr }
 */
export function generatePlan(mics, channels, opts = {}) {
  mics = mics || []; channels = channels || [];
  const rob = !!opts.rob || opts.mode === 'rob';
  const max = !!opts.max || opts.mode === 'max';
  const adv = (!!opts.adv || opts.mode === 'adv' || rob) && !max;
  const shuffle = !!opts.shuffle;
  const coord = { ...DEFAULT_COORD, ...(opts.coord || {}) };
  const isLk = m => !!m.locked && isFinite(m.freq);
  if (!channels.length || !mics.length)
    return { placed: new Array(mics.length).fill(null), freqs: [], nOK: 0, nKO: mics.length, adv, rob, max, reliab: null };

  const span = z => Array.isArray(z) ? { s: z[0], e: z[1] } : z;
  const occZones = channels.filter(c => c.occupied).map(c => ({ s: c.freq_start, e: c.freq_end }))
    .concat((opts.exclSpans || []).map(span)).concat((opts.scanSpans || []).map(span));
  const inOcc = f => occZones.some(z => f >= z.s && f < z.e);
  const legal = f => PLAN_BANDS.some(r => f >= r[0] && f <= r[1]);
  const nearOcc = f => occZones.some(z => f > z.s - 0.3 && f < z.e + 0.3);
  const blocked = f => nearOcc(f) || !legal(f);
  const chOf = f => f >= 470 && f < 694 ? Math.floor((f - 302) / 8) : (f >= 822 && f < 838 ? Math.floor((f - 302) / 8) : null);

  const GUARD = max ? 0.05 : guardMHzOf(coord);
  const rnd = opts.seed != null ? mulberry32(opts.seed >>> 0) : Math.random;
  const rk = mics.map(() => rnd());
  const order = mics.map((m, i) => i).filter(i => !isLk(mics[i])).sort((x, y) => {
    const wx = mics[x].fmax - mics[x].fmin, wy = mics[y].fmax - mics[y].fmin;
    return (wx !== wy ? wx - wy : (mics[y].spacing || 350) - (mics[x].spacing || 350)) || (shuffle ? rk[x] - rk[y] : 0);
  });

  const GUARD3 = 0.1, GUARD53 = 0.05;
  const placed = new Array(mics.length).fill(null);
  const setF = [];
  const imMask = maskNew(), im3Mask = maskNew(), im53Mask = maskNew(), im7Mask = maskNew(), carMask = maskNew();
  const polluted = new Set();
  const pairIM = (a, b) => [2 * a - b, 2 * b - a, 3 * a - 2 * b, 3 * b - 2 * a];
  const pair7 = (a, b) => [4 * a - 3 * b, 4 * b - 3 * a];
  const tri5 = (x, a, b) => [3 * x - a - b, 3 * a - x - b, 3 * b - x - a, 2 * x + a - 2 * b, 2 * x + b - 2 * a, 2 * a + x - 2 * b, 2 * a + b - 2 * x, 2 * b + x - 2 * a, 2 * b + a - 2 * x];

  function commit(idx, freq, sp) {
    for (const c of setF) for (const im of pairIM(freq, c.freq)) {
      maskMark(imMask, im, GUARD);
      const ch = chOf(im);
      if (ch != null && legal(im) && !inOcc(im)) polluted.add(ch);
    }
    for (let i = 0; i < setF.length; i++) for (let j = i + 1; j < setF.length; j++) {
      const a = setF[i].freq, b = setF[j].freq;
      for (const im of [freq + a - b, freq + b - a, a + b - freq]) maskMark(im3Mask, im, GUARD3);
      if (adv) for (const im of tri5(freq, a, b)) maskMark(im53Mask, im, GUARD53);
    }
    if (rob) for (const c of setF) for (const im of pair7(freq, c.freq)) maskMark(im7Mask, im, GUARD53);
    if (idx != null) placed[idx] = freq;
    setF.push({ freq, sp }); maskMark(carMask, freq, GUARD);
  }

  // fréquences réservées / verrous : pré-placés, les autres les contournent.
  (opts.fixed || []).concat((opts.reserved || []).map(f => ({ freq: f, sp: 0.2 })))
    .forEach(fx => { if (isFinite(fx.freq)) commit(null, fx.freq, fx.sp || 0.35); });
  mics.forEach((m, idx) => { if (isLk(m)) commit(idx, m.freq, (m.spacing || 350) / 1000); });

  for (const idx of order) {
    const m = mics[idx], sp = (m.spacing || 350) / 1000;
    const cands = [];
    const step = Math.max(0.005, (m.tuneStep || 25) / 1000);
    const sstep = step * (step < 0.04 ? 2 : 1);   // balayage 50 kHz (la grille d'accord reste respectée)
    const nSteps = Math.floor((m.fmax - m.fmin) / sstep + 1e-9);
    for (let k = 0; k <= nSteps; k++) {
      const f = Math.round((m.fmin + k * sstep) * 1000) / 1000;
      if (blocked(f)) continue;
      if (maskHit(imMask, f)) continue;
      let ok = true, score = 0, minD = 5;
      for (const c of setF) {
        const cf = c.freq, dd = f > cf ? f - cf : cf - f;
        if (dd < (sp > c.sp ? sp : c.sp)) { ok = false; break; }
        if (dd < minD) minD = dd;
        let im, ad;
        im = 2 * f - cf;     ad = im > f ? im - f : f - im; if (ad < GUARD || maskHit(carMask, im)) { ok = false; break; } if (inOcc(im)) score += 2; else if ((im >= 470 && im <= 694) || (im >= 822 && im <= 838)) { const ch = chOf(im); score -= (ch != null && polluted.has(ch)) ? 0.3 : 3; }
        im = 2 * cf - f;     ad = im > f ? im - f : f - im; if (ad < GUARD || maskHit(carMask, im)) { ok = false; break; } if (inOcc(im)) score += 2; else if ((im >= 470 && im <= 694) || (im >= 822 && im <= 838)) { const ch = chOf(im); score -= (ch != null && polluted.has(ch)) ? 0.3 : 3; }
        im = 3 * f - 2 * cf; ad = im > f ? im - f : f - im; if (ad < GUARD || maskHit(carMask, im)) { ok = false; break; } if (inOcc(im)) score += 2; else if ((im >= 470 && im <= 694) || (im >= 822 && im <= 838)) { const ch = chOf(im); score -= (ch != null && polluted.has(ch)) ? 0.3 : 3; }
        im = 3 * cf - 2 * f; ad = im > f ? im - f : f - im; if (ad < GUARD || maskHit(carMask, im)) { ok = false; break; } if (inOcc(im)) score += 2; else if ((im >= 470 && im <= 694) || (im >= 822 && im <= 838)) { const ch = chOf(im); score -= (ch != null && polluted.has(ch)) ? 0.3 : 3; }
      }
      if (!ok) continue;
      cands.push({ f, c3: maskHit(im3Mask, f) ? 1 : 0, score: score + Math.min(minD, 1.5) + (shuffle ? rnd() * 2 : 0) });
    }
    cands.sort((a, b) => a.c3 - b.c3 || b.score - a.score);
    let best = null, bestV = Infinity, clean = 0;
    if (max) { best = cands.length ? cands[0].f : null; }
    else for (const c of cands.slice(0, 800)) {
      let v = c.c3;
      if (adv) {
        cnt3: for (let i = 0; i < setF.length && v === 0; i++) for (let j = i + 1; j < setF.length; j++) {
          const a = setF[i].freq, b = setF[j].freq;
          for (const im of [c.f + a - b, c.f + b - a, a + b - c.f])
            if (maskHit(carMask, im) || Math.abs(im - c.f) < GUARD3) { v++; break cnt3; }
        }
        if (v > 0) continue;                  // 3TX interdit (avancé + robuste)
        if (rob) {
          let bad = (maskHit(im53Mask, c.f) || maskHit(im7Mask, c.f)) ? 1 : 0;
          if (!bad) for (const cc of setF) { for (const im of pair7(c.f, cc.freq)) if (maskHit(carMask, im) || Math.abs(im - c.f) < GUARD53) { bad = 1; break; } if (bad) break; }
          if (!bad) cnt5r: for (let i = 0; i < setF.length; i++) for (let j = i + 1; j < setF.length; j++) {
            for (const im of tri5(c.f, setF[i].freq, setF[j].freq))
              if (maskHit(carMask, im) || Math.abs(im - c.f) < GUARD53) { bad = 1; break cnt5r; }
          }
          if (bad) continue;
          best = c.f; break;
        }
        let v5 = maskHit(im53Mask, c.f) ? 1 : 0;
        cnt5: for (let i = 0; i < setF.length && v5 < bestV; i++) for (let j = i + 1; j < setF.length; j++) {
          for (const im of tri5(c.f, setF[i].freq, setF[j].freq))
            if (maskHit(carMask, im) || Math.abs(im - c.f) < GUARD53) { v5++; if (v5 >= bestV) break cnt5; }
        }
        if (v5 < bestV) { bestV = v5; best = c.f; }
        if (bestV === 0 || ++clean >= 25) break;
      } else {
        // standard (packing) : pénalise un 3TX sur porteuse, concentre les autres
        // dans la TNT occupée / canaux sacrifiés plutôt qu'une zone libre propre.
        let bad = c.c3 * 4;
        s3: for (let i = 0; i < setF.length; i++) for (let j = i + 1; j < setF.length; j++) {
          const a = setF[i].freq, b = setF[j].freq;
          for (const im of [c.f + a - b, c.f + b - a, a + b - c.f]) {
            if (maskHit(carMask, im) || Math.abs(im - c.f) < GUARD3) { bad += 100; if (bad >= bestV) break s3; }
            else if (legal(im) && !inOcc(im)) { const ch = chOf(im); bad += (ch != null && polluted.has(ch)) ? 0.1 : 1; }
          }
        }
        if (bad < bestV) { bestV = bad; best = c.f; }
        if (bestV < 1 || ++clean >= 40) break;
      }
    }
    if (best != null) commit(idx, best, sp);
  }

  const freqs = placed.filter(f => f != null);
  const nOK = freqs.length, nKO = mics.length - nOK;
  const planIM = [];
  for (let i = 0; i < freqs.length; i++) for (let j = i + 1; j < freqs.length; j++)
    pairIM(freqs[i], freqs[j]).forEach(v => { const im = parseFloat(v.toFixed(3)); if (legal(im) || inOcc(im)) planIM.push({ freq: im, inOcc: inOcc(im) }); });
  const imTV = planIM.filter(im => im.inOcc).length;
  const imFree = planIM.filter(im => !im.inOcc).length;
  const sacr = [...polluted].sort((a, b) => a - b);

  const car3 = maskNew(); freqs.forEach(f => maskMark(car3, f, GUARD3));
  let res3 = 0;
  for (let i = 0; i < freqs.length; i++) for (let j = i + 1; j < freqs.length; j++) for (let k = 0; k < freqs.length; k++) {
    if (k === i || k === j) continue;
    if (maskHit(car3, freqs[i] + freqs[j] - freqs[k])) res3++;
  }
  let res5 = 0;
  if (adv) {
    const car5 = maskNew(); freqs.forEach(f => maskMark(car5, f, GUARD53));
    for (let i = 0; i < freqs.length; i++) for (let j = i + 1; j < freqs.length; j++) for (let k = j + 1; k < freqs.length; k++)
      for (const im of tri5(freqs[i], freqs[j], freqs[k])) if (maskHit(car5, im)) res5++;
  }

  // Score de fiabilité : pire agresseur 2 tons (IM3/IM5/IM7) en dBc.
  const sortedF = [...freqs].sort((a, b) => a - b);
  const nearCar = x => {
    if (!sortedF.length) return Infinity;
    if (x <= sortedF[0]) return sortedF[0] - x;
    const hi = sortedF.length - 1; if (x >= sortedF[hi]) return x - sortedF[hi];
    let lo = 0, h = hi; while (h - lo > 1) { const md = (lo + h) >> 1; if (sortedF[md] < x) lo = md; else h = md; }
    return Math.min(Math.abs(x - sortedF[lo]), Math.abs(x - sortedF[h]));
  };
  const freqIEM = []; placed.forEach((f, i) => { if (f != null) freqIEM.push(!!(mics[i] && mics[i].kind === 'iem')); });
  let margin = Infinity, res2 = 0, worstDbc = -200;
  const HALF = 0.075;
  for (let i = 0; i < freqs.length; i++) for (let j = i + 1; j < freqs.length; j++) {
    const off = coupleDbcOf(coord, freqIEM[i] && freqIEM[j]);
    const prods = [[2 * freqs[i] - freqs[j], IM_DBC.im3], [2 * freqs[j] - freqs[i], IM_DBC.im3],
                   [3 * freqs[i] - 2 * freqs[j], IM_DBC.im5], [3 * freqs[j] - 2 * freqs[i], IM_DBC.im5]];
    if (rob) { prods.push([4 * freqs[i] - 3 * freqs[j], IM_DBC.im7], [4 * freqs[j] - 3 * freqs[i], IM_DBC.im7]); }
    for (const [im, base] of prods) {
      if (!legal(im) || inOcc(im)) continue;
      const d = nearCar(im); if (d < margin) margin = d; if (d < 0.0005) res2++;
      const lvl = imEffDbc(base, d, HALF, off); if (lvl > worstDbc) worstDbc = lvl;
    }
  }
  const marginKHz = isFinite(margin) ? Math.round(margin * 1000) : null;
  const dbc = worstDbc > -200 ? Math.round(worstDbc) : null;
  let grade;
  if (nKO > 0) grade = 'Partiel';
  else if (res2 === 0 && res3 === 0 && worstDbc <= -45) grade = 'Excellent';
  else if (res2 === 0 && worstDbc <= -25 && res3 <= nOK * 2) grade = 'Bon';
  else grade = 'Acceptable';
  const reliab = {
    marginKHz, dbc, res2, res3, capacity: nOK / Math.max(1, mics.length), grade,
    value: nOK * 100000 + (-Math.max(worstDbc, -60)) * 100 - res3 * 200 - res2 * 5000 - imFree * 10
  };
  return { placed, freqs, nOK, nKO, planIM, imTV, imFree, sacr, res3, res5, adv, rob, max, reliab };
}

/**
 * Plan auto « rapide & fiable » : optimise par redémarrages multiples (best-of-N)
 * sur le mode packing, puis avancé / capacité-max en appoint, et retient le meilleur
 * (capacité d'abord, puis fiabilité dBc). Rejoué exactement via sa graine.
 * @returns stats de generatePlan + { mode:'std'|'adv'|'max', seed }
 */
export function autoPlan(mics, channels, opts = {}) {
  const n = Math.max(1, (mics || []).length);
  const tries = opts.tries || Math.min(5, Math.max(2, Math.round(60 / n)));
  const base = { coord: opts.coord, scanSpans: opts.scanSpans, exclSpans: opts.exclSpans, fixed: opts.fixed, reserved: opts.reserved };
  const bestOf = (mode, t) => {
    let best = null;
    for (let s = 1; s <= t; s++) {
      const r = generatePlan(mics, channels, { ...base, ...mode, shuffle: true, seed: s });
      if (!r.reliab) return null;
      if (!best || r.reliab.value > best.r.reliab.value) best = { r, seed: s };
    }
    return best;
  };
  let best = null;
  const consider = (mode, bp) => { if (bp && (!best || bp.r.reliab.value > best.bp.r.reliab.value)) best = { mode, bp }; };
  consider({}, bestOf({}, tries));                       // packing : best-of-N
  consider({ adv: true }, bestOf({ adv: true }, 1));     // avancé (sans 3TX) : appoint
  if (best && best.bp.r.nKO > 0) consider({ max: true }, bestOf({ max: true }, 1)); // capacité max si besoin
  if (!best) return generatePlan(mics, channels, opts);
  const result = generatePlan(mics, channels, { ...base, ...best.mode, shuffle: true, seed: best.bp.seed });
  return { ...result, mode: best.mode.adv ? 'adv' : (best.mode.max ? 'max' : 'std'), seed: best.bp.seed };
}

/** Applique un résultat de plan aux micros : écrit mic.freq. */
export function applyPlan(mics, result) {
  (result.placed || []).forEach((f, i) => { if (f != null && mics[i]) { mics[i].freq = f; } });
  return mics;
}

/**
 * Liste les produits d'intermodulation d'un jeu de fréquences (inspection).
 * @returns [{ ord, kind, freq, src }]  — ord 3/5 (f3 absent) = 2 tons ; 3TX = 3 sources.
 */
export function computeIM(freqs, { im7 = false } = {}) {
  const out = [];
  const push = (ord, kind, src, f) => { const v = parseFloat(f.toFixed(3)); if (v > 30) out.push({ ord, kind, freq: v, src }); };
  for (let i = 0; i < freqs.length; i++) for (let j = i + 1; j < freqs.length; j++) {
    const a = freqs[i], b = freqs[j];
    push(3, 'IM3', [i, j], 2 * a - b); push(3, 'IM3', [i, j], 2 * b - a);
    push(5, 'IM5', [i, j], 3 * a - 2 * b); push(5, 'IM5', [i, j], 3 * b - 2 * a);
    if (im7) { push(7, 'IM7', [i, j], 4 * a - 3 * b); push(7, 'IM7', [i, j], 4 * b - 3 * a); }
    for (let k = j + 1; k < freqs.length; k++) {
      const c = freqs[k];
      push(3, '3TX', [i, j, k], a + b - c); push(3, '3TX', [i, j, k], a + c - b); push(3, '3TX', [i, j, k], b + c - a);
    }
  }
  return out;
}
