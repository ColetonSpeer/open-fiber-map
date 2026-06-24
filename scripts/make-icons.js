/*
 * Generates the source images @capacitor/assets needs, using sharp (already a
 * dependency of @capacitor/assets). Run via `npm run icons`, which then invokes
 * `capacitor-assets generate --ios` to produce the iOS icon set + splash.
 *
 * Design: dark-navy background with a fiber "splitter" motif — strands fanning
 * out from one input to several lit nodes, in a cyan→teal gradient.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const NAVY = '#1a1a2e';
const OUT = path.join(__dirname, '..', 'assets');
fs.mkdirSync(OUT, { recursive: true });

// The fiber motif: a centered hub with strands radiating to lit nodes — a fiber
// distribution point. Drawn in a 1024 design space, scaled/placed via (scale,cx,cy).
function motif(scale, cx, cy) {
  const HUB = [512, 512];
  const R = 312;            // node ring radius (keeps ~200px margin in 1024 space)
  const N = 7;
  const start = -Math.PI / 2; // first node points up
  let strands = '', dots = '';
  for (let i = 0; i < N; i++) {
    const a = start + (i * 2 * Math.PI) / N;
    const x = HUB[0] + R * Math.cos(a);
    const y = HUB[1] + R * Math.sin(a);
    // Gentle curve: bow the control point slightly off the straight line.
    const mx = (HUB[0] + x) / 2 - 28 * Math.sin(a);
    const my = (HUB[1] + y) / 2 + 28 * Math.cos(a);
    strands += `<path d="M ${HUB[0]} ${HUB[1]} Q ${mx.toFixed(0)} ${my.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)}" stroke="url(#g)" stroke-width="15" fill="none" stroke-linecap="round" opacity="0.95"/>`;
    dots += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="30" fill="#5eead4"/><circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="15" fill="#ffffff"/>`;
  }
  return `
    <g transform="translate(${cx - 512 * scale}, ${cy - 512 * scale}) scale(${scale})">
      ${strands}
      ${dots}
      <circle cx="${HUB[0]}" cy="${HUB[1]}" r="62" fill="url(#g)"/>
      <circle cx="${HUB[0]}" cy="${HUB[1]}" r="30" fill="#ffffff"/>
    </g>`;
}

function svg(size, withMotif) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#22d3ee"/>
        <stop offset="1" stop-color="#14b8a6"/>
      </linearGradient>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#16213e"/>
        <stop offset="1" stop-color="${NAVY}"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" fill="url(#bg)"/>
    ${withMotif ? motif(size / 1024, size / 2, size / 2) : ''}
  </svg>`;
}

async function render(name, size, withMotif) {
  const buf = Buffer.from(svg(size, withMotif));
  await sharp(buf).png().toFile(path.join(OUT, name));
  console.log('wrote', name, size + 'x' + size);
}

(async () => {
  // Icon: full-bleed motif (iOS masks the corners itself).
  await render('icon-only.png', 1024, true);
  // Splash: motif centered, generous margins handled by the larger canvas.
  await render('splash.png', 2732, true);
  await render('splash-dark.png', 2732, true);
})();
