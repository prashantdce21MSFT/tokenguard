// Brighter, glossier gauge icon for TokenGuard.
const React = require("react");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "..", "media", "options");
fs.mkdirSync(outDir, { recursive: true });

const CX = 256, CY = 300, R = 74;

function pt(a, r) { const rad = a * Math.PI / 180; return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)]; }
function arc(a0, a1, r, color, w, extra = "") {
  const pts = [];
  const step = a0 > a1 ? -2 : 2;
  for (let a = a0; step < 0 ? a >= a1 : a <= a1; a += step) { const [x, y] = pt(a, r); pts.push(x.toFixed(1) + "," + y.toFixed(1)); }
  return `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" ${extra}/>`;
}

// needle as a tapered polygon
const NEEDLE_A = 112;
const tip = pt(NEEDLE_A, R - 8);
const dir = [tip[0] - CX, tip[1] - CY];
const dl = Math.hypot(dir[0], dir[1]);
const nd = [dir[0] / dl, dir[1] / dl];
const perp = [-nd[1], nd[0]];
const wBase = 11;
const p1 = [CX + perp[0] * wBase, CY + perp[1] * wBase];
const p2 = [CX - perp[0] * wBase, CY - perp[1] * wBase];
const tail = [CX - nd[0] * 16, CY - nd[1] * 16];
const needle = `${tip[0].toFixed(1)},${tip[1].toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)} ${tail[0].toFixed(1)},${tail[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;

// tick marks
let ticks = "";
const nTicks = 9;
for (let i = 0; i < nTicks; i++) {
  const a = 184 - (190 / (nTicks - 1)) * i;
  const [ox, oy] = pt(a, R + 12);
  const [ix, iy] = pt(a, R + 4);
  const major = i === 0 || i === nTicks - 1 || i === Math.floor(nTicks / 2);
  ticks += `<line x1="${ix.toFixed(1)}" y1="${iy.toFixed(1)}" x2="${ox.toFixed(1)}" y2="${oy.toFixed(1)}" stroke="#EAF6EE" stroke-opacity="${major ? 0.9 : 0.45}" stroke-width="${major ? 4 : 2.5}" stroke-linecap="round"/>`;
}

const SHIELD_RIM = "M256 128 C301 146 340 157 382 162 L382 293 C382 355 328 400 256 427 C184 400 130 355 130 293 L130 162 C172 157 211 146 256 128 Z";
const SHIELD_BODY = "M256 140 C299 157 336 167 374 172 L374 291 C374 348 324 390 256 415 C188 390 138 348 138 291 L138 172 C176 167 213 157 256 140 Z";

const svg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="navy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1B3050"/><stop offset="1" stop-color="#0A1120"/></linearGradient>
  <radialGradient id="sheen" cx="0.32" cy="0.16" r="0.95"><stop offset="0" stop-color="#33477010" stop-opacity="0.9"/><stop offset="0.5" stop-color="#2A3A5C" stop-opacity="0"/></radialGradient>
  <radialGradient id="ambient" cx="0.5" cy="0.52" r="0.55"><stop offset="0" stop-color="#37FF6E" stop-opacity="0.35"/><stop offset="1" stop-color="#37FF6E" stop-opacity="0"/></radialGradient>
  <linearGradient id="shieldG" x1="0.25" y1="0" x2="0.75" y2="1">
    <stop offset="0" stop-color="#86FF98"/><stop offset="0.5" stop-color="#3DEA5C"/><stop offset="1" stop-color="#20C246"/>
  </linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D6FFDD"/><stop offset="1" stop-color="#15963A"/></linearGradient>
  <radialGradient id="gloss" cx="0.5" cy="0.12" r="0.7"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.72"/><stop offset="0.6" stop-color="#FFFFFF" stop-opacity="0.08"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
  <radialGradient id="hub" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.5" stop-color="#C4D2E2"/><stop offset="1" stop-color="#7C8AA0"/></radialGradient>
  <linearGradient id="needleG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DDE7F2"/></linearGradient>
  <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="glowStrong" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="16"/></filter>
</defs>

<rect width="512" height="512" rx="116" fill="url(#navy)"/>
<rect width="512" height="512" rx="116" fill="url(#sheen)"/>
<rect width="512" height="512" rx="116" fill="url(#ambient)"/>

<!-- outer green glow behind shield -->
<path d="${SHIELD_BODY}" fill="#5CFF7D" fill-opacity="0.55" filter="url(#glowStrong)"/>
<path d="${SHIELD_BODY}" fill="#5CFF7D" fill-opacity="0.30" filter="url(#glowStrong)"/>

<!-- shield drop shadow -->
<path d="${SHIELD_RIM}" fill="#000" fill-opacity="0.40" filter="url(#soft)" transform="translate(0,12)"/>

<!-- shield rim + bright body -->
<path d="${SHIELD_RIM}" fill="url(#rim)"/>
<path d="${SHIELD_BODY}" fill="url(#shieldG)"/>
<path d="${SHIELD_BODY}" fill="none" stroke="#CFFFD9" stroke-opacity="0.55" stroke-width="2.5"/>

<!-- dial plate -->
<circle cx="${CX}" cy="${CY}" r="98" fill="#0C3D1E" fill-opacity="0.35"/>
${ticks}

<!-- glowing tri-color arc -->
${arc(186, 132, R, "#6BFF8F", 24, 'filter="url(#glow)" stroke-opacity="0.9"')}
${arc(128, 52, R, "#FFDE5C", 24, 'filter="url(#glow)" stroke-opacity="0.9"')}
${arc(48, -6, R, "#FF7C6C", 24, 'filter="url(#glow)" stroke-opacity="0.9"')}
${arc(186, 132, R, "#55FF80", 15)}
${arc(128, 52, R, "#FFD84A", 15)}
${arc(48, -6, R, "#FF6E5E", 15)}

<!-- top gloss highlight on shield -->
<path d="M256 140 C299 157 336 167 374 172 L374 236 C316 254 196 254 138 236 L138 172 C176 167 213 157 256 140 Z" fill="url(#gloss)"/>

<!-- needle -->
<polygon points="${needle}" fill="url(#needleG)" stroke="#9FB0C6" stroke-width="0.6"/>
<circle cx="${CX}" cy="${CY}" r="17" fill="#0D1626"/>
<circle cx="${CX}" cy="${CY}" r="17" fill="url(#hub)" fill-opacity="0.25"/>
<circle cx="${CX}" cy="${CY}" r="11" fill="url(#hub)"/>
<circle cx="${(CX - 4).toFixed(1)}" cy="${(CY - 4).toFixed(1)}" r="3.5" fill="#FFFFFF" fill-opacity="0.9"/>

<!-- crisp specular streak -->
<path d="M180 176 C210 165 250 160 300 166 C255 178 210 186 190 212 Z" fill="#FFFFFF" fill-opacity="0.45" filter="url(#glow)"/>
</svg>`;

async function main() {
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  await sharp(buf).resize(512, 512).png().toFile(path.join(outDir, "gauge2.png"));
  await sharp(buf).resize(128, 128).png().toFile(path.join(outDir, "gauge2-128.png"));
  console.log("WROTE gauge2.png + gauge2-128.png");
}
main().catch(e => { console.error(e); process.exit(1); });
