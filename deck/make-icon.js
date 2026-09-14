// Generates the TokenGuard extension icon: a green shield (guard) + coin "$"
// on the brand dark-navy background, with the green/amber/red status-meter dots.
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const { FaDollarSign } = require("react-icons/fa");
const path = require("path");

const S = 512;
const CX = 256, COINY = 278, COINR = 80;

const bg = `
<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="navy" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#17233D"/>
      <stop offset="1" stop-color="#0A0F1C"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.3" cy="0.18" r="0.9">
      <stop offset="0" stop-color="#2A3A5C" stop-opacity="0.85"/>
      <stop offset="0.5" stop-color="#2A3A5C" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shield" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#49C85C"/>
      <stop offset="0.55" stop-color="#2EA043"/>
      <stop offset="1" stop-color="#1B7E36"/>
    </linearGradient>
    <linearGradient id="shieldRim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7DE88C"/>
      <stop offset="1" stop-color="#12692B"/>
    </linearGradient>
    <linearGradient id="coin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#DCE5F0"/>
    </linearGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
  </defs>

  <!-- background -->
  <rect x="0" y="0" width="${S}" height="${S}" rx="116" fill="url(#navy)"/>
  <rect x="0" y="0" width="${S}" height="${S}" rx="116" fill="url(#sheen)"/>
  <rect x="6" y="6" width="${S - 12}" height="${S - 12}" rx="110" fill="none" stroke="#000000" stroke-opacity="0.25" stroke-width="2"/>

  <!-- shield drop shadow -->
  <path d="M256 132 C300 149 338 160 378 165 L378 292 C378 352 326 396 256 422 C186 396 134 352 134 292 L134 165 C174 160 212 149 256 132 Z"
        fill="#000000" fill-opacity="0.35" filter="url(#soft)" transform="translate(0,10)"/>

  <!-- shield rim + body -->
  <path d="M256 128 C301 146 340 157 382 162 L382 293 C382 355 328 400 256 427 C184 400 130 355 130 293 L130 162 C172 157 211 146 256 128 Z"
        fill="url(#shieldRim)"/>
  <path d="M256 140 C299 157 336 167 374 172 L374 291 C374 348 324 390 256 415 C188 390 138 348 138 291 L138 172 C176 167 213 157 256 140 Z"
        fill="url(#shield)"/>
  <!-- top gloss -->
  <path d="M256 140 C299 157 336 167 374 172 L374 233 C312 250 200 250 138 233 L138 172 C176 167 213 157 256 140 Z"
        fill="#FFFFFF" fill-opacity="0.12"/>

  <!-- coin -->
  <circle cx="${CX}" cy="${COINY + 6}" r="${COINR}" fill="#000000" fill-opacity="0.28" filter="url(#soft)"/>
  <circle cx="${CX}" cy="${COINY}" r="${COINR}" fill="url(#coin)"/>
  <circle cx="${CX}" cy="${COINY}" r="${COINR - 8}" fill="none" stroke="#B9C6D8" stroke-opacity="0.8" stroke-width="3"/>

  <!-- status-meter dots -->
  <circle cx="${CX - 34}" cy="392" r="9" fill="#3FB950"/>
  <circle cx="${CX}" cy="392" r="9" fill="#E3B341"/>
  <circle cx="${CX + 34}" cy="392" r="9" fill="#F85149"/>
</svg>`;

async function main() {
  const dollarSvg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(FaDollarSign, { color: "#0D1626", size: "256" })
  );
  const dollarPng = await sharp(Buffer.from(dollarSvg)).resize({ height: 104 }).png().toBuffer();
  const meta = await sharp(dollarPng).metadata();
  const left = Math.round(CX - meta.width / 2);
  const top = Math.round(COINY - meta.height / 2);

  const base = sharp(Buffer.from(bg)).png();
  const composed = await base.composite([{ input: dollarPng, left, top }]).png().toBuffer();

  const mediaDir = path.join(__dirname, "..", "media");
  await sharp(composed).resize(512, 512).png().toFile(path.join(mediaDir, "icon.png"));
  await sharp(composed).resize(128, 128).png().toFile(path.join(mediaDir, "icon-128.png"));
  console.log("WROTE media/icon.png (512) and media/icon-128.png (128)");
}

main().catch(e => { console.error(e); process.exit(1); });
