// Run: node generate-icons.js
// Requires: npm install sharp
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const outDir = path.join(__dirname, 'public/icons');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// Generate a simple purple icon with "B" letter
async function generateIcon(size) {
  const svg = `
  <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#6C63FF"/>
        <stop offset="100%" style="stop-color:#4f46e5"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="url(#g)"/>
    <text x="50%" y="54%" font-family="Arial Black, Arial" font-weight="900"
      font-size="${size * 0.55}" fill="white" text-anchor="middle" dominant-baseline="middle">B</text>
  </svg>`;

  await sharp(Buffer.from(svg))
    .png()
    .toFile(path.join(outDir, `icon-${size}.png`));
  console.log(`✓ icon-${size}.png`);
}

(async () => {
  for (const size of sizes) await generateIcon(size);
  console.log('Done! Icons in public/icons/');
})();
