// tools/build.mjs — Build de déploiement : obscurcit le JS de l'app.
// Le source (frontend/index.html) reste lisible dans le repo ; seule la version
// publiée (_site/index.html) a son moteur obfusqué. Déterrent — non inviolable.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import JavaScriptObfuscator from 'javascript-obfuscator';

const SRC = 'frontend/index.html';
const html = readFileSync(SRC, 'utf8');

// Extrait l'unique <script> inline de l'app.
const open = html.indexOf('<script>');
if (open < 0) throw new Error('balise <script> introuvable');
const sOpen = html.indexOf('>', open) + 1;
const sEnd = html.indexOf('</script>', sOpen);
if (sEnd < 0) throw new Error('</script> introuvable');
const js = html.slice(sOpen, sEnd);

// Obfuscation conservatrice : on NE renomme PAS les globales (toggleLock, rmMic,
// print… appelées par des onclick inline) ni les clés d'objets. On mange les
// identifiants locaux et on encode les chaînes → corps de fonctions illisibles.
const res = JavaScriptObfuscator.obfuscate(js, {
  compact: true,
  renameGlobals: false,
  identifierNamesGenerator: 'mangled',
  transformObjectKeys: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  selfDefending: false,
  numbersToExpressions: false,
  simplify: true,
  splitStrings: false,
  stringArray: true,
  stringArrayThreshold: 0.7,
  stringArrayEncoding: ['base64'],
  unicodeEscapeSequence: false,
  target: 'browser',
});

const out = html.slice(0, sOpen) + '\n' + res.getObfuscatedCode() + '\n' + html.slice(sEnd);
mkdirSync('_site', { recursive: true });
writeFileSync('_site/index.html', out);
console.log(`_site/index.html écrit · JS source ${js.length} → obfusqué ${res.getObfuscatedCode().length} octets`);
