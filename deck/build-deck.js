const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");
const fs = require("fs");
const path = require("path");

// The shipped extension icon (gauge) — used as the brand mark across the deck.
const GAUGE = "image/png;base64," + fs.readFileSync(path.join(__dirname, "..", "media", "icon.png")).toString("base64");

// ---------- palette (GitHub-dark inspired, on-brand for a VS Code tool) ----------
const C = {
  bg: "0D1117",        // main dark
  bgAlt: "010409",     // deepest
  panel: "161B22",     // elevated card
  panel2: "1C2333",    // secondary card
  stroke: "30363D",    // hairline border
  text: "E6EDF3",      // primary text
  muted: "8B949E",     // muted text
  faint: "6E7681",     // faint
  green: "2EA043",     // savings / go
  greenBright: "3FB950",
  blue: "1F6FEB",      // primary action
  blueBright: "58A6FF",
  purple: "8957E5",    // credits / unit
  purpleBright: "A371F7",
  amber: "D29922",     // guardrails / warn
  amberBright: "E3B341",
  red: "DA3633",       // block / danger
  redBright: "F85149",
  teal: "39C5CF",
};

const FONT_H = "Consolas";       // monospace wordmark / headers — coder aesthetic
const FONT_B = "Segoe UI";       // clean body
const FONT_M = "Consolas";       // code / numbers

const pres = new pptxgen();
pres.defineLayout({ name: "TG", width: 13.333, height: 7.5 });
pres.layout = "TG";
pres.author = "TokenGuard";
pres.title = "TokenGuard — Live Token Economics Coach";
const W = 13.333, H = 7.5;

// ---------- icon rasterizer ----------
async function icon(Comp, color, size = 320) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Comp, { color: "#" + color, size: String(size) })
  );
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}

// ---------- helpers ----------
const shadow = () => ({ type: "outer", color: "000000", blur: 10, offset: 3, angle: 90, opacity: 0.35 });

function bg(slide, color = C.bg) { slide.background = { color }; }

function panel(slide, x, y, w, h, opts = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: opts.r ?? 0.12,
    fill: { color: opts.fill ?? C.panel },
    line: { color: opts.line ?? C.stroke, width: opts.lw ?? 1 },
    shadow: opts.shadow === false ? undefined : shadow(),
  });
}

// left accent tab motif — repeated across content slides
function accentTab(slide, y, color) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x: 0.0, y, w: 0.16, h: 0.62, rectRadius: 0.06,
    fill: { color }, line: { type: "none" },
  });
}

function kicker(slide, text, color) {
  slide.addText(text.toUpperCase(), {
    x: 0.72, y: 0.42, w: 9, h: 0.32, fontFace: FONT_M, fontSize: 12,
    color, bold: true, charSpacing: 3, align: "left", margin: 0,
  });
}

function title(slide, text, color = C.text) {
  slide.addText(text, {
    x: 0.7, y: 0.72, w: 12, h: 0.85, fontFace: FONT_H, fontSize: 30,
    color, bold: true, align: "left", margin: 0,
  });
}

let pageNo = 0;
function foot(slide, label) {
  pageNo++;
  slide.addImage({ data: GAUGE, x: 0.7, y: 6.95, w: 0.36, h: 0.36 });
  slide.addText([
    { text: "TokenGuard", options: { color: C.muted, bold: true } },
    { text: "   ·   " + label, options: { color: C.faint } },
  ], { x: 1.16, y: 6.95, w: 10, h: 0.36, fontFace: FONT_M, fontSize: 9, align: "left", valign: "middle", margin: 0 });
  slide.addText(String(pageNo).padStart(2, "0"), {
    x: W - 1.2, y: 7.02, w: 0.6, h: 0.3, fontFace: FONT_M, fontSize: 9,
    color: C.faint, align: "right", margin: 0,
  });
}

// dotted grid texture for dark slides (subtle depth)
function dotField(slide, x, y, cols, rows, gap, color, sz = 0.02) {
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      slide.addShape(pres.shapes.OVAL, {
        x: x + c * gap, y: y + r * gap, w: sz, h: sz,
        fill: { color }, line: { type: "none" },
      });
}

async function build() {
  // pre-render icons
  const I = {
    shield: await icon(fa.FaShieldAlt, C.green),
    shieldW: await icon(fa.FaShieldAlt, C.text),
    dollar: await icon(fa.FaDollarSign, C.green),
    flag: await icon(fa.FaFlag, C.amber),
    wrench: await icon(fa.FaWrench, C.blueBright),
    receipt: await icon(fa.FaReceipt, C.purpleBright),
    dish: await icon(fa.FaSatelliteDish, C.teal),
    recycle: await icon(fa.FaRecycle, C.greenBright),
    folder: await icon(fa.FaFolderOpen, C.blueBright),
    snow: await icon(fa.FaSnowflake, C.teal),
    lock: await icon(fa.FaLock, C.redBright),
    layers: await icon(fa.FaLayerGroup, C.purpleBright),
    money: await icon(fa.FaMoneyBillWave, C.amberBright),
    ruler: await icon(fa.FaRulerHorizontal, C.blueBright),
    brain: await icon(fa.FaBrain, C.purpleBright),
    gauge: await icon(fa.FaTachometerAlt, C.green),
    coins: await icon(fa.FaCoins, C.amberBright),
    cut: await icon(fa.FaCut, C.redBright),
    target: await icon(fa.FaBullseye, C.blueBright),
    chart: await icon(fa.FaChartLine, C.greenBright),
    check: await icon(fa.FaCheckCircle, C.greenBright),
    times: await icon(fa.FaTimesCircle, C.redBright),
    arrowUp: await icon(fa.FaArrowUp, C.redBright),
    arrowDn: await icon(fa.FaArrowDown, C.greenBright),
    bolt: await icon(fa.FaBolt, C.amberBright),
    engine: await icon(fa.FaCarSide, C.muted),
    compass: await icon(fa.FaCompass, C.green),
    balance: await icon(fa.FaCalculator, C.green),
    eye: await icon(fa.FaEye, C.blueBright),
    fingerprint: await icon(fa.FaFingerprint, C.purpleBright),
    bulb: await icon(fa.FaLightbulb, C.amberBright),
    sliders: await icon(fa.FaSlidersH, C.blueBright),
    download: await icon(fa.FaDownload, C.purpleBright),
  };

  function iconChip(slide, x, y, d, ring, sz = 0.9, iw = 0.5) {
    slide.addShape(pres.shapes.OVAL, { x, y, w: sz, h: sz, fill: { color: C.bgAlt }, line: { color: ring, width: 1.5 } });
    slide.addImage({ data: d, x: x + (sz - iw) / 2, y: y + (sz - iw) / 2, w: iw, h: iw });
  }

  // ============================================================ SLIDE 1 — TITLE
  {
    const s = pres.addSlide(); bg(s, C.bgAlt);
    // ambient panels
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: W, h: H, fill: { color: C.bgAlt }, line: { type: "none" } });
    dotField(s, 8.7, 0.5, 22, 26, 0.2, "1B2230");
    // big soft brand block on the right
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 9.1, y: 1.55, w: 3.4, h: 3.4, rectRadius: 0.4, fill: { color: "0F1622" }, line: { color: C.stroke, width: 1 }, shadow: shadow() });
    s.addImage({ data: GAUGE, x: 9.6, y: 1.8, w: 2.4, h: 2.4 });
    s.addText("8 live guardrails", { x: 9.1, y: 4.35, w: 3.4, h: 0.4, align: "center", fontFace: FONT_M, fontSize: 12, color: C.green, bold: true, margin: 0 });

    // left accent bar
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.12, h: H, fill: { color: C.green }, line: { type: "none" } });

    s.addText("VS CODE  ·  CHAT PARTICIPANT  ·  @tokenguard", {
      x: 0.9, y: 1.35, w: 8, h: 0.35, fontFace: FONT_M, fontSize: 13, color: C.blueBright, bold: true, charSpacing: 2, margin: 0,
    });
    s.addText("TokenGuard", {
      x: 0.82, y: 1.75, w: 8.4, h: 1.5, fontFace: FONT_H, fontSize: 76, color: C.text, bold: true, margin: 0,
    });
    // tagline strip
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.9, y: 3.25, w: 7.2, h: 0.7, rectRadius: 0.1, fill: { color: "1A1408" }, line: { color: C.amber, width: 1 } });
    s.addImage({ data: I.bolt, x: 1.12, y: 3.44, w: 0.32, h: 0.32 });
    s.addText("Cheaper tokens.  Exploding bills.", {
      x: 1.55, y: 3.25, w: 6.4, h: 0.7, fontFace: FONT_H, fontSize: 21, italic: true, color: C.amberBright, bold: true, valign: "middle", margin: 0,
    });

    s.addText("Your live token-economics coach — right inside VS Code chat. It watches every AI request before it runs, prices it in tokens · dollars · credits, flags the mistakes that quietly drain your budget, and refuses to let you pay twice for the same answer.", {
      x: 0.9, y: 4.2, w: 7.5, h: 1.5, fontFace: FONT_B, fontSize: 15, color: C.muted, lineSpacingMultiple: 1.25, align: "left", margin: 0,
    });

    // unit chips
    const chips = [["tokens", C.blueBright], ["dollars", C.greenBright], ["credits", C.purpleBright]];
    let cx = 0.9;
    chips.forEach(([t, col]) => {
      const w = 0.5 + t.length * 0.13;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: 5.85, w, h: 0.5, rectRadius: 0.25, fill: { color: C.panel }, line: { color: col, width: 1 } });
      s.addText(t, { x: cx, y: 5.85, w, h: 0.5, align: "center", valign: "middle", fontFace: FONT_M, fontSize: 13, color: col, bold: true, margin: 0 });
      cx += w + 0.25;
    });

    s.addText("Built to make every token a decision — not a surprise.", {
      x: 0.9, y: 6.75, w: 8, h: 0.35, fontFace: FONT_B, fontSize: 12, italic: true, color: C.faint, margin: 0,
    });
  }

  // ============================================================ SLIDE 2 — THE PARADOX
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.amber);
    kicker(s, "Why it exists", C.amber);
    title(s, "The paradox that's draining AI budgets");

    // two big stat callouts
    const statY = 1.95;
    // down price
    panel(s, 0.7, statY, 3.75, 2.05, { fill: C.panel });
    s.addImage({ data: I.arrowDn, x: 1.02, y: statY + 0.32, w: 0.5, h: 0.5 });
    s.addText("Per-token prices", { x: 1.7, y: statY + 0.34, w: 2.6, h: 0.35, fontFace: FONT_B, fontSize: 14, color: C.muted, bold: true, margin: 0 });
    s.addText("COLLAPSED", { x: 1.02, y: statY + 0.95, w: 3.4, h: 0.7, fontFace: FONT_H, fontSize: 40, color: C.greenBright, bold: true, margin: 0 });
    s.addText("The headline price of a token keeps falling.", { x: 1.02, y: statY + 1.62, w: 3.3, h: 0.35, fontFace: FONT_B, fontSize: 11, color: C.faint, margin: 0 });

    // up bills
    panel(s, 4.65, statY, 3.75, 2.05, { fill: C.panel });
    s.addImage({ data: I.arrowUp, x: 4.97, y: statY + 0.32, w: 0.5, h: 0.5 });
    s.addText("Enterprise AI bills", { x: 5.65, y: statY + 0.34, w: 2.6, h: 0.35, fontFace: FONT_B, fontSize: 14, color: C.muted, bold: true, margin: 0 });
    s.addText("KEEP CLIMBING", { x: 4.97, y: statY + 0.95, w: 3.4, h: 0.7, fontFace: FONT_H, fontSize: 34, color: C.redBright, bold: true, margin: 0 });
    s.addText("Yet the invoice at the end of the month grows.", { x: 4.97, y: statY + 1.62, w: 3.3, h: 0.35, fontFace: FONT_B, fontSize: 11, color: C.faint, margin: 0 });

    // snowball callout on the right
    panel(s, 8.6, statY, 4.03, 2.05, { fill: "0F1720", line: C.teal });
    s.addImage({ data: I.snow, x: 8.9, y: statY + 0.3, w: 0.55, h: 0.55 });
    s.addText("The context snowball", { x: 9.55, y: statY + 0.34, w: 2.9, h: 0.4, fontFace: FONT_H, fontSize: 16, color: C.teal, bold: true, valign: "middle", margin: 0 });
    s.addText("Agentic workloads re-read their entire, growing context on every step — so consumption compounds turn over turn, even as unit prices fall.", {
      x: 8.9, y: statY + 1.0, w: 3.45, h: 1.0, fontFace: FONT_B, fontSize: 12.5, color: C.text, lineSpacingMultiple: 1.2, margin: 0,
    });

    // bottom insight bar
    panel(s, 0.7, 4.5, 11.93, 1.95, { fill: C.panel2 });
    s.addImage({ data: I.eye, x: 1.05, y: 4.85, w: 0.6, h: 0.6 });
    s.addText("The cost of an AI feature is now decided by HOW you use it — not in procurement.", {
      x: 1.9, y: 4.72, w: 10.4, h: 0.6, fontFace: FONT_H, fontSize: 20, color: C.text, bold: true, valign: "middle", margin: 0,
    });
    s.addText([
      { text: "Model choice, context size, caching, retries, output length — a dozen editor-time decisions each move the bill. ", options: { color: C.muted } },
      { text: "TokenGuard makes that hidden cost visible & controllable — live, in the editor.", options: { color: C.greenBright, bold: true } },
    ], { x: 1.9, y: 5.4, w: 10.4, h: 0.9, fontFace: FONT_B, fontSize: 14, lineSpacingMultiple: 1.25, valign: "top", margin: 0 });

    foot(s, "The paradox");
  }

  // ============================================================ SLIDE 3 — FIVE THINGS EVERY TURN
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.green);
    kicker(s, "The 30-second pitch", C.green);
    title(s, "Type @tokenguard — five things, every single turn");

    const cards = [
      ["01", "Estimate", I.dollar, C.green, "Cost before it runs, in tokens, dollars & credits."],
      ["02", "Flag", I.flag, C.amber, "8 live guardrails catch budget-draining mistakes."],
      ["03", "Run", I.wrench, C.blueBright, "Answers from your real folder with read-only tools."],
      ["04", "Reconcile", I.receipt, C.purpleBright, "A receipt: actual cost vs the estimate."],
      ["05", "Log", I.dish, C.teal, "Every turn as OpenTelemetry to usage.jsonl."],
    ];
    const n = cards.length, gap = 0.3, x0 = 0.7, totalW = 11.93;
    const cw = (totalW - gap * (n - 1)) / n, cy = 2.15, ch = 3.35;
    cards.forEach(([num, name, ic, col, desc], i) => {
      const x = x0 + i * (cw + gap);
      panel(s, x, cy, cw, ch, { fill: C.panel });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: cy, w: cw, h: 0.1, rectRadius: 0.05, fill: { color: col }, line: { type: "none" } });
      s.addText(num, { x: x + 0.2, y: cy + 0.28, w: cw - 0.4, h: 0.4, fontFace: FONT_M, fontSize: 14, color: C.faint, bold: true, margin: 0 });
      iconChip(s, x + (cw - 1.0) / 2, cy + 0.8, ic, col, 1.0, 0.55);
      s.addText(name, { x: x + 0.1, y: cy + 1.95, w: cw - 0.2, h: 0.45, align: "center", fontFace: FONT_H, fontSize: 19, color: C.text, bold: true, margin: 0 });
      s.addText(desc, { x: x + 0.18, y: cy + 2.45, w: cw - 0.36, h: 0.85, align: "center", fontFace: FONT_B, fontSize: 11.5, color: C.muted, lineSpacingMultiple: 1.15, margin: 0 });
    });

    // budget footer band
    panel(s, 0.7, 5.85, 11.93, 0.75, { fill: "0F1A12", line: C.green, shadow: false });
    s.addImage({ data: GAUGE, x: 1.0, y: 5.98, w: 0.5, h: 0.5 });
    s.addText([
      { text: "…all while enforcing a ", options: { color: C.muted } },
      { text: "session + daily token budget", options: { color: C.greenBright, bold: true } },
      { text: " you control  🎯", options: { color: C.muted } },
    ], { x: 1.55, y: 5.85, w: 10.8, h: 0.75, valign: "middle", fontFace: FONT_B, fontSize: 15, margin: 0 });

    foot(s, "Five things, every turn");
  }

  // ============================================================ SLIDE 4 — HOW A TURN FLOWS
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.blue);
    kicker(s, "The lifecycle", C.blueBright);
    title(s, "How a turn flows");

    // main pipeline nodes
    const node = (x, y, w, h, label, sub, col, ic) => {
      panel(s, x, y, w, h, { fill: C.panel, line: col });
      if (ic) s.addImage({ data: ic, x: x + 0.18, y: y + (h - 0.34) / 2, w: 0.34, h: 0.34 });
      const tx = ic ? x + 0.62 : x + 0.15;
      const tw = ic ? w - 0.72 : w - 0.3;
      s.addText([
        { text: label, options: { color: C.text, bold: true, fontSize: 13, breakLine: true } },
        { text: sub, options: { color: C.muted, fontSize: 9.5 } },
      ], { x: tx, y, w: tw, h, valign: "middle", fontFace: FONT_M, align: "left", margin: 0, lineSpacingMultiple: 1.05 });
    };
    const arrow = (x, y, w) => s.addShape(pres.shapes.LINE, { x, y, w, h: 0, line: { color: C.faint, width: 1.75, endArrowType: "triangle" } });

    const rowY = 2.25, nh = 0.95;
    node(0.7, rowY, 2.15, nh, "You type", "@tokenguard …", C.blue, I.shieldW);
    arrow(2.9, rowY + nh / 2, 0.45);
    node(3.4, rowY, 2.15, nh, "Estimate", "tokens · $ · credits", C.green, I.dollar);
    arrow(5.6, rowY + nh / 2, 0.45);
    node(6.1, rowY, 2.15, nh, "8 guardrails", "score the request", C.amber, I.flag);
    arrow(8.3, rowY + nh / 2, 0.45);
    node(8.8, rowY, 2.15, nh, "Run", "workspace tools", C.blueBright, I.wrench);

    // branch outcomes from guardrails
    const by = 3.75;
    s.addShape(pres.shapes.LINE, { x: 7.17, y: rowY + nh, w: 0, h: 0.35, line: { color: C.faint, width: 1.5 } });
    s.addShape(pres.shapes.LINE, { x: 2.4, y: by + 0.3, w: 9.55, h: 0, line: { color: C.stroke, width: 1, dashType: "dash" } });

    const branch = (x, w, label, sub, col, ic) => {
      s.addShape(pres.shapes.LINE, { x: x + w / 2, y: by + 0.3, w: 0, h: 0.28, line: { color: col, width: 1.5, endArrowType: "triangle" } });
      panel(s, x, by + 0.58, w, 0.95, { fill: C.panel2, line: col });
      s.addImage({ data: ic, x: x + 0.2, y: by + 0.58 + (0.95 - 0.34) / 2, w: 0.34, h: 0.34 });
      s.addText([
        { text: label, options: { color: col, bold: true, fontSize: 12.5, breakLine: true } },
        { text: sub, options: { color: C.muted, fontSize: 9.5 } },
      ], { x: x + 0.64, y: by + 0.58, w: w - 0.75, h: 0.95, valign: "middle", fontFace: FONT_M, align: "left", margin: 0 });
    };
    branch(0.7, 3.55, "Duplicate → skip", "returns the prior answer, saves the tokens", C.green, I.recycle);
    branch(4.9, 3.5, "Over budget → warn / block", "you stay in control of the ceiling", C.red, I.times);
    branch(8.95, 3.68, "All clear → run", "executes with tiered, read-only tools", C.blueBright, I.check);

    // tail pipeline: compact -> receipt -> log
    const ty = 5.75;
    const tail = (x, w, label, sub, col, ic) => {
      panel(s, x, ty, w, nh, { fill: C.panel, line: col });
      s.addImage({ data: ic, x: x + 0.2, y: ty + (nh - 0.36) / 2, w: 0.36, h: 0.36 });
      s.addText([
        { text: label, options: { color: C.text, bold: true, fontSize: 13, breakLine: true } },
        { text: sub, options: { color: C.muted, fontSize: 9.5 } },
      ], { x: x + 0.66, y: ty, w: w - 0.8, h: nh, valign: "middle", fontFace: FONT_M, align: "left", margin: 0 });
    };
    tail(0.7, 3.7, "Compact", "defuse the snowball if context balloons", C.teal, I.cut);
    arrow(4.4, ty + nh / 2, 0.45);
    tail(4.9, 3.7, "Receipt", "actual vs estimate, per turn", C.purpleBright, I.receipt);
    arrow(8.6, ty + nh / 2, 0.45);
    tail(9.1, 3.53, "usage.jsonl", "OpenTelemetry, ground truth", C.green, I.dish);

    foot(s, "How a turn flows");
  }

  // ============================================================ SLIDE 5 — EIGHT GUARDRAILS
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.amber);
    kicker(s, "The playbook, enforced", C.amber);
    title(s, "Eight live guardrails");
    s.addText("Every request is scored against the token-economics playbook before a single token is spent.", {
      x: 0.72, y: 1.4, w: 12, h: 0.35, fontFace: FONT_B, fontSize: 13.5, color: C.muted, margin: 0,
    });

    const rails = [
      [I.recycle, C.green, "Duplicate request", "Asking the same thing twice → skips it, saves the tokens."],
      [I.folder, C.blueBright, "Whole workspace attached", "Re-reading everything, every turn."],
      [I.snow, C.teal, "Context snowball", "History ballooning turn-over-turn."],
      [I.lock, C.redBright, "Sensitive data", "Matches your configured sensitive-data patterns."],
      [I.layers, C.purpleBright, "Cache-unfriendly order", "Variable content before stable instructions."],
      [I.money, C.amberBright, "Overkill model", "Frontier model on a routine task → names a cheaper one + $ saved."],
      [I.ruler, C.blueBright, "No output cap", "Verbose generation with no brevity instruction."],
      [I.brain, C.purpleBright, "Reasoning surcharge", "Hidden thinking tokens that would otherwise undercount."],
    ];
    const cols = 2, rows = 4, gx = 0.3, gy = 0.18;
    const x0 = 0.7, y0 = 1.9, cw = (11.93 - gx) / cols, ch = 1.05;
    rails.forEach(([ic, col, name, desc], i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = x0 + c * (cw + gx), y = y0 + r * (ch + gy);
      panel(s, x, y, cw, ch, { fill: C.panel });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 0.09, h: ch, rectRadius: 0.04, fill: { color: col }, line: { type: "none" } });
      iconChip(s, x + 0.28, y + (ch - 0.72) / 2, ic, col, 0.72, 0.4);
      s.addText(name, { x: x + 1.2, y: y + 0.16, w: cw - 1.35, h: 0.4, fontFace: FONT_H, fontSize: 15, color: C.text, bold: true, margin: 0 });
      s.addText(desc, { x: x + 1.2, y: y + 0.55, w: cw - 1.4, h: 0.5, fontFace: FONT_B, fontSize: 11.5, color: C.muted, lineSpacingMultiple: 1.1, margin: 0 });
    });

    foot(s, "Eight live guardrails");
  }

  // ============================================================ SLIDE 6 — FEATURE HIGHLIGHTS
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.purple);
    kicker(s, "What makes it different", C.purpleBright);
    title(s, "Not just a warning — a working coach");

    const feats = [
      [I.gauge, C.green, "Budget control", "Session + daily ceilings, persisted. Status-bar meter goes green → amber → red. Optional hard block."],
      [I.coins, C.amberBright, "Three currencies", "Every turn priced in tokens, dollars (in/out split), and Copilot credits."],
      [I.wrench, C.blueBright, "Real tools", "Read-only list · read · grep · find so it answers from your actual folder."],
      [I.cut, C.teal, "Real compaction", "Summarises old tool results in place — defuses the snowball, not just warns."],
      [I.target, C.purpleBright, "Tiered tools", "Sends only the tools relevant to your prompt — not every schema, every call."],
      [I.dish, C.greenBright, "OTel export", "Rich per-turn record in GenAI semantic conventions, ready for your Observability Hub."],
    ];
    const cols = 3, rows = 2, gx = 0.3, gy = 0.3;
    const x0 = 0.7, y0 = 2.0, cw = (11.93 - gx * (cols - 1)) / cols, ch = 2.15;
    feats.forEach(([ic, col, name, desc], i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = x0 + c * (cw + gx), y = y0 + r * (ch + gy);
      panel(s, x, y, cw, ch, { fill: C.panel });
      iconChip(s, x + 0.3, y + 0.3, ic, col, 0.85, 0.46);
      s.addText(name, { x: x + 0.3, y: y + 1.2, w: cw - 0.6, h: 0.4, fontFace: FONT_H, fontSize: 17, color: C.text, bold: true, margin: 0 });
      s.addText(desc, { x: x + 0.3, y: y + 1.6, w: cw - 0.55, h: 0.5, fontFace: FONT_B, fontSize: 11.5, color: C.muted, lineSpacingMultiple: 1.15, margin: 0 });
    });

    foot(s, "Feature highlights");
  }

  // ============================================================ SLIDE 7 — WHAT A TURN LOOKS LIKE
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.green);
    kicker(s, "In the chat", C.green);
    title(s, "What a turn looks like");

    // terminal window
    const tx = 0.7, ty = 1.9, tw = 7.9, th = 4.55;
    panel(s, tx, ty, tw, th, { fill: C.bgAlt, line: C.stroke, r: 0.1 });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: ty, w: tw, h: 0.5, rectRadius: 0.1, fill: { color: "12161D" }, line: { type: "none" } });
    ["FF5F56", "FFBD2E", "27C93F"].forEach((c, i) =>
      s.addShape(pres.shapes.OVAL, { x: tx + 0.25 + i * 0.28, y: ty + 0.17, w: 0.16, h: 0.16, fill: { color: c }, line: { type: "none" } }));
    s.addText("TokenGuard · chat", { x: tx + 1.3, y: ty, w: tw - 1.5, h: 0.5, valign: "middle", fontFace: FONT_M, fontSize: 10, color: C.faint, margin: 0 });

    const line = (y, runs) => s.addText(runs, { x: tx + 0.3, y, w: tw - 0.55, h: 0.32, fontFace: FONT_M, fontSize: 11, valign: "middle", align: "left", margin: 0, lineSpacingMultiple: 1.0 });
    let ly = ty + 0.62;
    line(ly, [{ text: "🛡 TokenGuard · turn 3 · session tg-m4x2p-a7f9c1", options: { color: C.greenBright, bold: true } }]); ly += 0.34;
    line(ly, [{ text: "This request: ~8,028 in + ~2,000 out ≈ ", options: { color: C.muted } }, { text: "$0.020", options: { color: C.amberBright, bold: true } }, { text: " on gemini-3-flash", options: { color: C.muted } }]); ly += 0.32;
    line(ly, [{ text: "Session: ", options: { color: C.muted } }, { text: "36%", options: { color: C.blueBright, bold: true } }, { text: " of budget · $0.011   Today: ", options: { color: C.muted } }, { text: "27%", options: { color: C.blueBright, bold: true } }, { text: " · $1.79", options: { color: C.muted } }]); ly += 0.4;
    line(ly, [{ text: "💸 Cheaper model likely enough — try gemini-1.5-flash:", options: { color: C.amberBright } }]); ly += 0.3;
    line(ly, [{ text: "   ~$0.002 vs $0.490 · ", options: { color: C.muted } }, { text: "saves 100%", options: { color: C.greenBright, bold: true } }]); ly += 0.4;
    s.addShape(pres.shapes.LINE, { x: tx + 0.3, y: ly, w: tw - 0.6, h: 0, line: { color: C.stroke, width: 1, dashType: "dash" } }); ly += 0.16;
    line(ly, [{ text: "…the actual answer, using your workspace…", options: { color: C.text, italic: true } }]); ly += 0.34;
    s.addShape(pres.shapes.LINE, { x: tx + 0.3, y: ly, w: tw - 0.6, h: 0, line: { color: C.stroke, width: 1, dashType: "dash" } }); ly += 0.16;
    line(ly, [{ text: "🧾 This turn actually cost: 11,641 in + 370 out", options: { color: C.purpleBright, bold: true } }]); ly += 0.3;
    line(ly, [{ text: "   = $0.016 · ≈ 1 credit ", options: { color: C.muted } }, { text: "(−18% vs est.)", options: { color: C.greenBright, bold: true } }]);

    // right column — reading the receipt
    const rx = 8.85, rw = 3.78;
    const rc = (y, ic, col, head, body) => {
      panel(s, rx, y, rw, 1.36, { fill: C.panel });
      iconChip(s, rx + 0.22, y + 0.24, ic, col, 0.68, 0.38);
      s.addText(head, { x: rx + 1.05, y: y + 0.2, w: rw - 1.2, h: 0.38, fontFace: FONT_H, fontSize: 14, color: C.text, bold: true, margin: 0 });
      s.addText(body, { x: rx + 1.05, y: y + 0.58, w: rw - 1.25, h: 0.7, fontFace: FONT_B, fontSize: 11, color: C.muted, lineSpacingMultiple: 1.12, margin: 0 });
    };
    rc(1.9, I.dollar, C.green, "Priced up-front", "Tokens, dollars and credits before the model runs — no bill-time surprises.");
    rc(3.42, I.money, C.amberBright, "A cheaper path", "When a frontier model is overkill, it names the smaller one and the $ saved.");
    rc(4.94, I.receipt, C.purpleBright, "Reconciled after", "A receipt shows what it really cost vs the estimate — closing the loop.");

    foot(s, "What a turn looks like");
  }

  // ============================================================ SLIDE 8 — OTEL EXPORT
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.teal);
    kicker(s, "Ground truth, on disk", C.teal);
    title(s, "…and what it quietly writes to disk");

    // code panel
    const tx = 0.7, ty = 1.9, tw = 7.4, th = 4.55;
    panel(s, tx, ty, tw, th, { fill: C.bgAlt, line: C.stroke, r: 0.1 });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: ty, w: tw, h: 0.46, rectRadius: 0.1, fill: { color: "12161D" }, line: { type: "none" } });
    s.addText(".tokenguard / usage.jsonl", { x: tx + 0.3, y: ty, w: tw - 0.5, h: 0.46, valign: "middle", fontFace: FONT_M, fontSize: 10.5, color: C.faint, margin: 0 });

    const rows = [
      ['"gen_ai.request.model"', ': "claude-opus-4.8",', C.blueBright],
      ['"gen_ai.usage.input_tokens"', ": 11370,", C.text],
      ['"gen_ai.usage.output_tokens"', ": 1373,", C.text],
      ['"gen_ai.server.time_to_first_token_ms"', ": 4460,", C.text],
      ['"gen_ai.client.operation.duration_ms"', ": 22240,", C.text],
      ['"tokenguard.cost_usd"', ": 0.27,", C.amberBright],
      ['"tokenguard.tool_calls_count"', ": 3,", C.text],
      ['"tokenguard.tool_names"', ': ["tg_grep", …],', C.text],
      ['"tokenguard.tokens_saved_by_tiering"', ": 31812,", C.greenBright],
      ['"tokenguard.suggested_cheaper_model"', ': "gemini-1.5-flash",', C.greenBright],
      ['"tokenguard.session_id"', ': "tg-m4x2p-a7f9c1",', C.purpleBright],
      ['"tokenguard.turn_index"', ": 3", C.purpleBright],
    ];
    let ly = ty + 0.62;
    s.addText([{ text: "{", options: { color: C.muted } }], { x: tx + 0.3, y: ly, w: 2, h: 0.28, fontFace: FONT_M, fontSize: 10.5, margin: 0 }); ly += 0.28;
    rows.forEach(([k, v, col]) => {
      s.addText([
        { text: "  " + k, options: { color: C.teal } },
        { text: v, options: { color: col } },
      ], { x: tx + 0.3, y: ly, w: tw - 0.5, h: 0.28, fontFace: FONT_M, fontSize: 10.5, valign: "middle", margin: 0 });
      ly += 0.28;
    });
    s.addText([{ text: "}", options: { color: C.muted } }], { x: tx + 0.3, y: ly, w: 2, h: 0.28, fontFace: FONT_M, fontSize: 10.5, margin: 0 });

    // right callout — five metrics
    const rx = 8.35, rw = 4.28;
    panel(s, rx, 1.9, rw, 4.55, { fill: "0F1A1A", line: C.teal });
    s.addImage({ data: I.chart, x: rx + 0.35, y: 2.2, w: 0.6, h: 0.6 });
    s.addText("One line. Every metric that matters.", { x: rx + 1.1, y: 2.2, w: rw - 1.3, h: 0.6, valign: "middle", fontFace: FONT_H, fontSize: 15, color: C.text, bold: true, margin: 0 });
    s.addText("The five numbers the research keeps demanding — captured automatically, per turn:", {
      x: rx + 0.35, y: 2.95, w: rw - 0.6, h: 0.6, fontFace: FONT_B, fontSize: 12, color: C.muted, lineSpacingMultiple: 1.2, margin: 0,
    });
    const metrics = [["Tokens / task", C.blueBright], ["Cost / task", C.amberBright], ["Latency", C.text], ["Retries", C.purpleBright], ["Savings", C.greenBright]];
    let my = 3.7;
    metrics.forEach(([m, col]) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: rx + 0.35, y: my, w: rw - 0.7, h: 0.45, rectRadius: 0.08, fill: { color: C.panel }, line: { color: C.stroke, width: 1 } });
      s.addShape(pres.shapes.OVAL, { x: rx + 0.55, y: my + 0.16, w: 0.13, h: 0.13, fill: { color: col }, line: { type: "none" } });
      s.addText(m, { x: rx + 0.85, y: my, w: rw - 1.2, h: 0.45, valign: "middle", fontFace: FONT_M, fontSize: 13, color: C.text, bold: true, margin: 0 });
      my += 0.55;
    });

    foot(s, "OpenTelemetry export");
  }

  // ============================================================ SLIDE 9 — HISTORICAL ANALYTICS
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.blue);
    kicker(s, "Beyond estimates", C.blueBright);
    title(s, "Ground-truth analytics from Copilot's own logs");

    const cards = [
      [I.chart, C.greenBright, "Real Historical Usage", "Reads the real promptTokens / outputTokens Copilot persists — aggregated per model, per workspace.", "Not an estimate."],
      [I.fingerprint, C.purpleBright, "Personal Calibration", "Learns per-model baselines — output/input ratio, avg cost — and auto-corrects the live rules.", "Self-tuning rules."],
      [I.check, C.blueBright, "Edit ROI", "Scores each AI-edited file — kept · rework · discarded · pending — attributed to the model that made it.", "Did the edits stick?"],
    ];
    const cols = 3, gx = 0.3, x0 = 0.7, y0 = 1.95, cw = (11.93 - gx * (cols - 1)) / cols, ch = 3.35;
    cards.forEach(([ic, col, name, body, tag], i) => {
      const x = x0 + i * (cw + gx);
      panel(s, x, y0, cw, ch, { fill: C.panel });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: y0, w: cw, h: 0.1, rectRadius: 0.05, fill: { color: col }, line: { type: "none" } });
      iconChip(s, x + 0.35, y0 + 0.4, ic, col, 0.9, 0.5);
      s.addText(name, { x: x + 0.35, y: y0 + 1.45, w: cw - 0.7, h: 0.45, fontFace: FONT_H, fontSize: 17, color: C.text, bold: true, margin: 0 });
      s.addText(body, { x: x + 0.35, y: y0 + 1.9, w: cw - 0.65, h: 0.8, fontFace: FONT_B, fontSize: 12, color: C.muted, lineSpacingMultiple: 1.2, margin: 0 });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + 0.35, y: y0 + ch - 0.62, w: cw - 0.7, h: 0.42, rectRadius: 0.08, fill: { color: C.panel2 }, line: { color: col, width: 1 } });
      s.addText(tag, { x: x + 0.35, y: y0 + ch - 0.62, w: cw - 0.7, h: 0.42, align: "center", valign: "middle", fontFace: FONT_M, fontSize: 12, color: col, bold: true, margin: 0 });
    });

    panel(s, 0.7, 5.55, 11.93, 0.9, { fill: "0F1620", line: C.blue, shadow: false });
    s.addImage({ data: I.eye, x: 1.0, y: 5.78, w: 0.44, h: 0.44 });
    s.addText([
      { text: "Reads Copilot's persisted logs — so Real Usage, Calibration and Edit ROI cover ", options: { color: C.muted } },
      { text: "all your chats, not just @tokenguard ones.", options: { color: C.blueBright, bold: true } },
    ], { x: 1.6, y: 5.55, w: 10.8, h: 0.9, valign: "middle", fontFace: FONT_B, fontSize: 14, margin: 0, lineSpacingMultiple: 1.15 });

    foot(s, "Ground-truth analytics");
  }

  // ============================================================ SLIDE 10 — USAGE DASHBOARD
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.green);
    kicker(s, "See it — then save it", C.green);
    title(s, "The usage dashboard");

    // ---- left: mock dashboard window ----
    const tx = 0.7, ty = 1.9, tw = 7.4, th = 4.55;
    panel(s, tx, ty, tw, th, { fill: C.bgAlt, line: C.stroke, r: 0.1 });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: ty, w: tw, h: 0.46, rectRadius: 0.1, fill: { color: "12161D" }, line: { type: "none" } });
    ["FF5F56", "FFBD2E", "27C93F"].forEach((c, i) => s.addShape(pres.shapes.OVAL, { x: tx + 0.25 + i * 0.28, y: ty + 0.15, w: 0.16, h: 0.16, fill: { color: c }, line: { type: "none" } }));
    s.addText("TokenGuard — Usage Dashboard", { x: tx + 1.3, y: ty, w: tw - 1.5, h: 0.46, valign: "middle", fontFace: FONT_M, fontSize: 10, color: C.faint, margin: 0 });

    // stat cards row
    const dcards = [["$4.60", "total cost", C.red], ["$0.08", "$/turn", C.amber], ["71%", "input cost", C.blue], ["460", "credits", C.purple]];
    const cy = ty + 0.62, cardW = (tw - 0.6 - 0.3 * 3) / 4, cardH = 0.82;
    dcards.forEach(([v, l, col], i) => {
      const x = tx + 0.3 + i * (cardW + 0.3);
      panel(s, x, cy, cardW, cardH, { fill: C.panel, shadow: false });
      s.addShape(pres.shapes.RECTANGLE, { x, y: cy, w: 0.06, h: cardH, fill: { color: col }, line: { type: "none" } });
      s.addText(v, { x: x + 0.16, y: cy + 0.12, w: cardW - 0.2, h: 0.4, fontFace: FONT_H, fontSize: 17, color: C.text, bold: true, margin: 0 });
      s.addText(l, { x: x + 0.16, y: cy + 0.5, w: cardW - 0.2, h: 0.28, fontFace: FONT_B, fontSize: 9, color: C.muted, margin: 0 });
    });

    // insights strip
    const iy = cy + cardH + 0.2;
    panel(s, tx + 0.3, iy, tw - 0.6, 0.92, { fill: "1A1408", line: C.amber, shadow: false });
    s.addText("💡 Savings & Insights", { x: tx + 0.5, y: iy + 0.1, w: 3, h: 0.3, fontFace: FONT_H, fontSize: 12, color: C.amberBright, bold: true, margin: 0 });
    s.addText([{ text: "📊 claude-opus-4.8 is your biggest driver — 90% of spend", options: { color: C.muted } }], { x: tx + 0.5, y: iy + 0.4, w: tw - 1.6, h: 0.24, fontFace: FONT_M, fontSize: 9.5, margin: 0 });
    s.addText([{ text: "💸 Move routine work to a flash-class model  ", options: { color: C.muted } }, { text: "save $4.51", options: { color: C.greenBright, bold: true } }], { x: tx + 0.5, y: iy + 0.63, w: tw - 1.6, h: 0.24, fontFace: FONT_M, fontSize: 9.5, margin: 0 });

    // mini stacked bar chart
    const gy0 = iy + 0.92 + 0.2, gH = th - (gy0 - ty) - 0.3, gx0 = tx + 0.4, gW = tw - 0.8;
    const yb = gy0 + gH - 0.1;
    s.addText("Cost over time · stacked by model", { x: gx0, y: gy0 - 0.06, w: 4, h: 0.24, fontFace: FONT_B, fontSize: 9, color: C.faint, margin: 0 });
    const nb = 9, bw = 0.42, gap = (gW - nb * bw) / (nb - 1);
    const ddata = [[0.5, 0.25, 0.15], [0.7, 0.3, 0.1], [0.4, 0.35, 0.2], [0.9, 0.25, 0.12], [0.6, 0.4, 0.15], [1.0, 0.3, 0.1], [0.75, 0.5, 0.2], [0.55, 0.35, 0.18], [0.85, 0.45, 0.14]];
    const maxTot = Math.max(...ddata.map(d => d[0] + d[1] + d[2]));
    const scale = (gH - 0.35) / maxTot;
    ddata.forEach((d, i) => {
      const x = gx0 + i * (bw + gap); let yy = yb;
      [[d[0], C.red], [d[1], C.purple], [d[2], C.green]].forEach(([val, col]) => { const hh = val * scale; yy -= hh; s.addShape(pres.shapes.RECTANGLE, { x, y: yy, w: bw, h: hh, fill: { color: col }, line: { type: "none" } }); });
    });
    s.addShape(pres.shapes.LINE, { x: gx0, y: yb, w: gW, h: 0, line: { color: C.stroke, width: 1 } });

    // ---- right: feature callouts ----
    const rx = 8.35, rw = 4.28;
    const feats = [
      [I.bulb, C.amberBright, "Savings & insights", "Biggest cost driver, cheaper-model what-ifs, snowball & priciest-session flags."],
      [I.sliders, C.blueBright, "Cost efficiency", "$/turn, $/1k in & out, out/in ratio, and an input▸output cost split per model."],
      [I.chart, C.greenBright, "Trends & deltas", "7-day vs prior delta, cumulative Σ line, 7-day moving average, hover readouts."],
      [I.download, C.purpleBright, "Export", "One click to CSV or JSON of exactly what you've filtered."],
    ];
    const fgap = 0.22, fh = (th - fgap * 3) / 4;
    feats.forEach(([ic, col, name, desc], i) => {
      const y = ty + i * (fh + fgap);
      panel(s, rx, y, rw, fh, { fill: C.panel });
      iconChip(s, rx + 0.28, y + (fh - 0.72) / 2, ic, col, 0.72, 0.4);
      s.addText(name, { x: rx + 1.2, y: y + 0.16, w: rw - 1.35, h: 0.36, fontFace: FONT_H, fontSize: 15, color: C.text, bold: true, margin: 0 });
      s.addText(desc, { x: rx + 1.2, y: y + 0.52, w: rw - 1.4, h: fh - 0.62, fontFace: FONT_B, fontSize: 11, color: C.muted, lineSpacingMultiple: 1.12, margin: 0 });
    });

    foot(s, "The usage dashboard");
  }

  // ============================================================ SLIDE 11 — WHERE IT FITS
  {
    const s = pres.addSlide(); bg(s);
    accentTab(s, 0.4, C.green);
    kicker(s, "Where it fits", C.green);
    title(s, "The engine vs the fuel gauge");

    // harness card
    panel(s, 0.7, 1.95, 5.75, 2.75, { fill: C.panel });
    iconChip(s, 1.0, 2.25, I.engine, C.muted, 0.9, 0.5);
    s.addText("The Agent Framework harness", { x: 2.05, y: 2.3, w: 4.3, h: 0.5, valign: "middle", fontFace: FONT_H, fontSize: 16, color: C.text, bold: true, margin: 0 });
    s.addText("🏎  The engine — with cost controls built in.", { x: 1.0, y: 3.3, w: 5.15, h: 0.4, fontFace: FONT_B, fontSize: 13, italic: true, color: C.muted, margin: 0 });
    s.addText("Production runtime: background agents, shell execution, approval policy — the machinery that actually does the work.", {
      x: 1.0, y: 3.75, w: 5.2, h: 0.9, fontFace: FONT_B, fontSize: 12, color: C.faint, lineSpacingMultiple: 1.2, margin: 0,
    });

    // tokenguard card
    panel(s, 6.88, 1.95, 5.75, 2.75, { fill: "0F1A12", line: C.green });
    iconChip(s, 7.18, 2.25, I.gauge, C.green, 0.9, 0.5);
    s.addText("TokenGuard", { x: 8.23, y: 2.3, w: 4.2, h: 0.5, valign: "middle", fontFace: FONT_H, fontSize: 16, color: C.text, bold: true, margin: 0 });
    s.addText("⛽  The live fuel gauge + driving coach.", { x: 7.18, y: 3.3, w: 5.2, h: 0.4, fontFace: FONT_B, fontSize: 13, italic: true, color: C.greenBright, margin: 0 });
    s.addText("Bolted onto your chat — the live, human-facing cost coaching the harness lacks. It makes every editor-time decision visible.", {
      x: 7.18, y: 3.75, w: 5.2, h: 0.9, fontFace: FONT_B, fontSize: 12, color: C.text, lineSpacingMultiple: 1.2, margin: 0,
    });

    // ports strip
    panel(s, 0.7, 5.0, 11.93, 1.45, { fill: C.panel2 });
    s.addText("Ports the harness's cost-and-context core into VS Code chat:", {
      x: 1.0, y: 5.15, w: 11, h: 0.4, fontFace: FONT_B, fontSize: 13, color: C.muted, bold: true, margin: 0,
    });
    const ports = [["Loop control", C.blueBright], ["Compaction", C.teal], ["Tiered tools", C.purpleBright], ["OTel export", C.greenBright]];
    let px = 1.0;
    const pw = 2.85;
    ports.forEach(([p, col]) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: px, y: 5.6, w: pw, h: 0.62, rectRadius: 0.1, fill: { color: C.panel }, line: { color: col, width: 1 } });
      s.addShape(pres.shapes.OVAL, { x: px + 0.22, y: 5.83, w: 0.16, h: 0.16, fill: { color: col }, line: { type: "none" } });
      s.addText(p, { x: px + 0.5, y: 5.6, w: pw - 0.6, h: 0.62, valign: "middle", fontFace: FONT_M, fontSize: 13, color: C.text, bold: true, margin: 0 });
      px += pw + 0.13;
    });

    foot(s, "Where it fits");
  }

  // ============================================================ SLIDE 11 — CLOSING
  {
    const s = pres.addSlide(); bg(s, C.bgAlt);
    dotField(s, 0.5, 5.4, 60, 8, 0.2, "161B22");
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.12, h: H, fill: { color: C.green }, line: { type: "none" } });

    s.addImage({ data: GAUGE, x: 0.9, y: 1.1, w: 1.35, h: 1.35 });
    s.addText("Every token a decision —", {
      x: 0.9, y: 2.55, w: 11.5, h: 0.95, fontFace: FONT_H, fontSize: 46, color: C.text, bold: true, margin: 0,
    });
    s.addText("not a surprise.", {
      x: 0.9, y: 3.45, w: 11.5, h: 0.95, fontFace: FONT_H, fontSize: 46, color: C.greenBright, bold: true, margin: 0,
    });

    // quick start chip
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.9, y: 4.7, w: 6.2, h: 0.7, rectRadius: 0.1, fill: { color: C.bg }, line: { color: C.stroke, width: 1 } });
    s.addText([
      { text: "$ ", options: { color: C.green, bold: true } },
      { text: "code --install-extension tokenguard.vsix", options: { color: C.text } },
    ], { x: 1.15, y: 4.7, w: 5.9, h: 0.7, valign: "middle", fontFace: FONT_M, fontSize: 13, margin: 0 });
    s.addText("then type  @tokenguard  in chat", { x: 7.25, y: 4.7, w: 5, h: 0.7, valign: "middle", fontFace: FONT_M, fontSize: 12, italic: true, color: C.muted, margin: 0 });

    // honest limits
    s.addText("HONEST LIMITS", { x: 0.9, y: 5.75, w: 6, h: 0.3, fontFace: FONT_M, fontSize: 11, color: C.faint, bold: true, charSpacing: 2, margin: 0 });
    const limits = [
      "Guides only @tokenguard turns live",
      "$ & credits are estimates, not the exact bill",
      "File tools are read-only, not a full runtime",
    ];
    let lx = 0.9;
    const lw = 3.9;
    limits.forEach((t) => {
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: lx, y: 6.1, w: lw, h: 0.72, rectRadius: 0.1, fill: { color: C.panel }, line: { color: C.stroke, width: 1 } });
      s.addText(t, { x: lx + 0.2, y: 6.1, w: lw - 0.35, h: 0.72, valign: "middle", fontFace: FONT_B, fontSize: 11.5, color: C.muted, lineSpacingMultiple: 1.05, margin: 0 });
      lx += lw + 0.12;
    });
  }

  await pres.writeFile({ fileName: "c:\\Prashant AI gold standard\\tokenguard\\TokenGuard.pptx" });
  console.log("WROTE TokenGuard.pptx");
}

build().catch((e) => { console.error(e); process.exit(1); });
