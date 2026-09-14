// Builds TokenGuard wordmark lockups (gauge icon + name) in a few layouts.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const optDir = path.join(__dirname, "..", "media", "options");
const gaugePath = path.join(optDir, "gauge2.png");
const gaugeB64 = "data:image/png;base64," + fs.readFileSync(gaugePath).toString("base64");

const NAME = `<tspan fill="#E9EEF3">Token</tspan><tspan fill="#3DEA5C">Guard</tspan>`;
const FONT = "Segoe UI, Arial, sans-serif";

// 1 · horizontal, transparent background
const horiz = `<svg width="1360" height="420" viewBox="0 0 1360 420" xmlns="http://www.w3.org/2000/svg">
  <image href="${gaugeB64}" x="30" y="55" width="310" height="310"/>
  <text x="380" y="228" font-family="${FONT}" font-size="150" font-weight="800" letter-spacing="-2">${NAME}</text>
  <text x="386" y="300" font-family="${FONT}" font-size="44" font-weight="500" fill="#8B949E">Live token-economics coach</text>
</svg>`;

// 2 · horizontal on a dark rounded banner
const banner = `<svg width="1360" height="420" viewBox="0 0 1360 420" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#111A2B"/><stop offset="1" stop-color="#0A0F1C"/></linearGradient></defs>
  <rect width="1360" height="420" rx="60" fill="url(#bg)"/>
  <image href="${gaugeB64}" x="45" y="55" width="310" height="310"/>
  <text x="395" y="228" font-family="${FONT}" font-size="150" font-weight="800" letter-spacing="-2">${NAME}</text>
  <text x="401" y="300" font-family="${FONT}" font-size="44" font-weight="500" fill="#8B949E">Live token-economics coach</text>
</svg>`;

// 3 · stacked (icon over name), transparent
const stacked = `<svg width="900" height="720" viewBox="0 0 900 720" xmlns="http://www.w3.org/2000/svg">
  <image href="${gaugeB64}" x="290" y="20" width="320" height="320"/>
  <text x="450" y="480" text-anchor="middle" font-family="${FONT}" font-size="130" font-weight="800" letter-spacing="-2">${NAME}</text>
  <text x="450" y="545" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="500" fill="#8B949E">Live token-economics coach</text>
</svg>`;

async function main() {
  await sharp(Buffer.from(horiz)).png().toFile(path.join(optDir, "wordmark-horizontal.png"));
  await sharp(Buffer.from(banner)).png().toFile(path.join(optDir, "wordmark-banner.png"));
  await sharp(Buffer.from(stacked)).png().toFile(path.join(optDir, "wordmark-stacked.png"));
  console.log("WROTE wordmark-horizontal.png, wordmark-banner.png, wordmark-stacked.png");
}
main().catch(e => { console.error(e); process.exit(1); });
