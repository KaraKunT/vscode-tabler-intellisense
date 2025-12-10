const fs = require("fs");
const path = require("path");

const ICONS_DIR = path.join(__dirname, "media", "icons");

// İstediğin yeni boyut:
const NEW_SIZE = 15; // 14, 16, 18 yapabilirsin
 
const NEW_COLOR = "#ff3b30"; // İstediğin renk kodu.
//const NEW_COLOR = "currentColor"; // İstediğin renk kodu.

function processFile(filePath) {
  let svg = fs.readFileSync(filePath, "utf8");

  // width / height küçült
  svg = svg.replace(/(\s|^)(width|height)="[^"]*"/g, `$1$2="${NEW_SIZE}"`);

  // stroke="none" olanları es geç (sadece none olmayan stroke değerlerini değiştir)
  svg = svg.replace(/stroke="(?!none\b)[^"]*"/g, `stroke="${NEW_COLOR}"`);

  fs.writeFileSync(filePath, svg, "utf8");
  console.log("OK:", path.basename(filePath));
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && full.endsWith(".svg")) {
      processFile(full);
    }
  }
}

console.log("Başlıyor:", ICONS_DIR);
walk(ICONS_DIR);
console.log("Bitti.");
