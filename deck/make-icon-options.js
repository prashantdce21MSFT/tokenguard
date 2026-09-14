// Renders several TokenGuard icon concepts + a contact sheet for comparison.
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FaDollarSign } = require("react-icons/fa");
const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "..", "media", "options");
fs.mkdirSync(outDir, { recursive: true });

const DEFS = `
  <linearGradient id="navy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17233D"/><stop offset="1" stop-color="#0A0F1C"/></linearGradient>
  <radialGradient id="sheen" cx="0.3" cy="0.18" r="0.9"><stop offset="0" stop-color="#2A3A5C" stop-opacity="0.85"/><stop offset="0.5" stop-color="#2A3A5C" stop-opacity="0"/></radialGradient>
  <linearGradient id="shieldG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#49C85C"/><stop offset="0.55" stop-color="#2EA043"/><stop offset="1" stop-color="#1B7E36"/></linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7DE88C"/><stop offset="1" stop-color="#12692B"/></linearGradient>
  <linearGradient id="coin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DCE5F0"/></linearGradient>
  <filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
`;

const SHIELD_RIM = "M256 128 C301 146 340 157 382 162 L382 293 C382 355 328 400 256 427 C184 400 130 355 130 293 L130 162 C172 157 211 146 256 128 Z";
const SHIELD_BODY = "M256 140 C299 157 336 167 374 172 L374 291 C374 348 324 390 256 415 C188 390 138 348 138 291 L138 172 C176 167 213 157 256 140 Z";

function bgNavy() {
  return `<rect width="512" height="512" rx="116" fill="url(#navy)"/><rect width="512" height="512" rx="116" fill="url(#sheen)"/><rect x="6" y="6" width="500" height="500" rx="110" fill="none" stroke="#000" stroke-opacity="0.25" stroke-width="2"/>`;
}
function bgLight() {
  return `<rect width="512" height="512" rx="116" fill="#EEF2F8"/><rect x="6" y="6" width="500" height="500" rx="110" fill="none" stroke="#0000" stroke-opacity="0.06" stroke-width="2"/>`;
}
function svg(inner) { return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><defs>${DEFS}</defs>${inner}</svg>`; }

function arcPolyline(cx, cy, R, a0, a1, color, width) {
  const pts = [];
  const step = a0 > a1 ? -3 : 3;
  for (let a = a0; step < 0 ? a >= a1 : a <= a1; a += step) {
    const r = a * Math.PI / 180;
    pts.push((cx + R * Math.cos(r)).toFixed(1) + "," + (cy - R * Math.sin(r)).toFixed(1));
  }
  return `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

// ---- concept builders (return SVG string; some need a composited $) ----
const concepts = {
  // 1 · Classic glossy shield + coin + $
  classic: {
    needDollar: { color: "#0D1626", h: 104, cx: 256, cy: 278 },
    svg: () => svg(`${bgNavy()}
      <path d="${SHIELD_RIM}" fill="#000" fill-opacity="0.35" filter="url(#soft)" transform="translate(0,10)"/>
      <path d="${SHIELD_RIM}" fill="url(#rim)"/>
      <path d="${SHIELD_BODY}" fill="url(#shieldG)"/>
      <path d="M256 140 C299 157 336 167 374 172 L374 233 C312 250 200 250 138 233 L138 172 C176 167 213 157 256 140 Z" fill="#FFF" fill-opacity="0.12"/>
      <circle cx="256" cy="284" r="80" fill="#000" fill-opacity="0.28" filter="url(#soft)"/>
      <circle cx="256" cy="278" r="80" fill="url(#coin)"/>
      <circle cx="256" cy="278" r="72" fill="none" stroke="#B9C6D8" stroke-opacity="0.8" stroke-width="3"/>
      <circle cx="222" cy="392" r="9" fill="#3FB950"/><circle cx="256" cy="392" r="9" fill="#E3B341"/><circle cx="290" cy="392" r="9" fill="#F85149"/>`)
  },

  // 2 · Flat modern shield + bold white $ (no coin, no gloss)
  flat: {
    needDollar: { color: "#FFFFFF", h: 190, cx: 256, cy: 268 },
    svg: () => svg(`${bgNavy()}
      <path d="${SHIELD_BODY}" fill="#2EA043"/>
      <path d="M256 140 C299 157 336 167 374 172 L374 278 L138 278 L138 172 C176 167 213 157 256 140 Z" fill="#33AE49"/>`)
  },

  // 3 · Budget gauge inside shield (speedometer)
  gauge: {
    needDollar: null,
    svg: () => svg(`${bgNavy()}
      <path d="${SHIELD_RIM}" fill="#000" fill-opacity="0.35" filter="url(#soft)" transform="translate(0,10)"/>
      <path d="${SHIELD_RIM}" fill="url(#rim)"/>
      <path d="${SHIELD_BODY}" fill="url(#shieldG)"/>
      ${arcPolyline(256, 300, 74, 186, 132, "#3FB950", 20)}
      ${arcPolyline(256, 300, 74, 128, 52, "#E3B341", 20)}
      ${arcPolyline(256, 300, 74, 48, -6, "#F85149", 20)}
      <line x1="256" y1="300" x2="212" y2="248" stroke="#FFFFFF" stroke-width="11" stroke-linecap="round"/>
      <circle cx="256" cy="300" r="15" fill="#0D1626"/><circle cx="256" cy="300" r="15" fill="none" stroke="#FFF" stroke-width="3"/>`)
  },

  // 4 · "T" monogram shield
  monogram: {
    needDollar: null,
    svg: () => svg(`${bgNavy()}
      <path d="${SHIELD_RIM}" fill="#000" fill-opacity="0.35" filter="url(#soft)" transform="translate(0,10)"/>
      <path d="${SHIELD_RIM}" fill="url(#rim)"/>
      <path d="${SHIELD_BODY}" fill="url(#shieldG)"/>
      <rect x="196" y="222" width="120" height="26" rx="8" fill="#FFFFFF"/>
      <rect x="243" y="222" width="26" height="118" rx="8" fill="#FFFFFF"/>
      <circle cx="222" cy="384" r="8" fill="#3FB950"/><circle cx="256" cy="384" r="8" fill="#E3B341"/><circle cx="290" cy="384" r="8" fill="#F85149"/>`)
  },

  // 5 · Duotone line style: green shield outline with $ knockout
  outline: {
    needDollar: { color: "#3FB950", h: 150, cx: 256, cy: 268 },
    svg: () => svg(`${bgNavy()}
      <path d="${SHIELD_BODY}" fill="none" stroke="#3FB950" stroke-width="18" stroke-linejoin="round"/>`)
  },

  // 6 · Chat bubble + shield ($ inside) — nods to the @tokenguard chat participant
  chat: {
    needDollar: { color: "#2EA043", h: 92, cx: 256, cy: 250 },
    svg: () => svg(`${bgNavy()}
      <path d="M120 128 h272 a40 40 0 0 1 40 40 v150 a40 40 0 0 1 -40 40 h-150 l-70 62 v-62 h-52 a40 40 0 0 1 -40 -40 v-150 a40 40 0 0 1 40 -40 Z" fill="#1E7F38"/>
      <path d="M120 120 h272 a40 40 0 0 1 40 40 v150 a40 40 0 0 1 -40 40 h-150 l-70 62 v-62 h-52 a40 40 0 0 1 -40 -40 v-150 a40 40 0 0 1 40 -40 Z" fill="url(#shieldG)"/>
      <path d="M256 168 C286 180 312 187 340 190 L340 262 C340 300 306 328 256 344 C206 328 172 300 172 262 L172 190 C200 187 226 180 256 168 Z" fill="#FFFFFF"/>`)
  },
};

async function dollarPng(color, h) {
  const s = ReactDOMServer.renderToStaticMarkup(React.createElement(FaDollarSign, { color, size: "256" }));
  return sharp(Buffer.from(s)).resize({ height: h }).png().toBuffer();
}

async function renderConcept(name) {
  const c = concepts[name];
  let img = sharp(Buffer.from(c.svg())).png();
  if (c.needDollar) {
    const d = await dollarPng(c.needDollar.color, c.needDollar.h);
    const m = await sharp(d).metadata();
    img = sharp(await img.composite([{ input: d, left: Math.round(c.needDollar.cx - m.width / 2), top: Math.round(c.needDollar.cy - m.height / 2) }]).png().toBuffer());
  }
  const buf = await img.resize(512, 512).png().toBuffer();
  await sharp(buf).toFile(path.join(outDir, name + ".png"));
  return buf;
}

async function main() {
  const order = ["classic", "flat", "gauge", "monogram", "outline", "chat"];
  const bufs = {};
  for (const n of order) { bufs[n] = await renderConcept(n); }

  // contact sheet: 3 cols x 2 rows, each cell shows big icon + small preview
  const cell = 340, pad = 30, iconBig = 210, iconSmall = 60;
  const cols = 3, rows = 2;
  const W = pad + cols * (cell + pad), H = pad + rows * (cell + pad);
  const sheet = sharp({ create: { width: W, height: H, channels: 4, background: { r: 13, g: 17, b: 28, alpha: 1 } } });
  const comps = [];
  for (let i = 0; i < order.length; i++) {
    const r = Math.floor(i / cols), col = i % cols;
    const cx = pad + col * (cell + pad), cy = pad + r * (cell + pad);
    const big = await sharp(bufs[order[i]]).resize(iconBig, iconBig).png().toBuffer();
    const small = await sharp(bufs[order[i]]).resize(iconSmall, iconSmall).png().toBuffer();
    comps.push({ input: big, left: cx + Math.round((cell - iconBig) / 2), top: cy + 24 });
    comps.push({ input: small, left: cx + cell - iconSmall - 24, top: cy + cell - iconSmall - 20 });
    // number badge (drawn as SVG circle + digit-free ring; number given in chat)
    const badge = Buffer.from(`<svg width="52" height="52" xmlns="http://www.w3.org/2000/svg"><circle cx="26" cy="26" r="24" fill="#0D1626" stroke="#2EA043" stroke-width="3"/><text x="26" y="35" font-family="Arial" font-size="28" fill="#3FB950" text-anchor="middle" font-weight="bold">${i + 1}</text></svg>`);
    comps.push({ input: await sharp(badge).png().toBuffer(), left: cx + 16, top: cy + 16 });
  }
  await sheet.composite(comps).png().toFile(path.join(outDir, "icon-options.png"));
  console.log("WROTE " + path.join(outDir, "icon-options.png"));
}

main().catch(e => { console.error(e); process.exit(1); });
