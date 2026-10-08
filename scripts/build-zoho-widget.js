/**
 * Packs the Exotel CTI widget into the zip Zoho CRM hosts.
 *
 *   npm run zoho:widget        -> out/zoho-cti-widget.zip
 *
 * Upload it in Zoho CRM: Setup > Developer Hub > Widgets > Create, Hosting
 * "Zoho". The index pages are /cti.html (the CTI on the Call button),
 * /phone.html (the same CTI as the Phone web tab, kept open all day),
 * /history.html (the CTI opened on its call history, for a "Call history"
 * button) and /admin.html (the admin web tab). bridge.html lets the Phone
 * tab reach the Call button's pages. The Exotel WebSDK is copied in from
 * public/vendor for SIP mode.
 *
 * Writes the zip itself (deflate from zlib) rather than pulling in a package.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "zoho-cti", "widget", "app");
const MANIFEST = path.join(ROOT, "zoho-cti", "widget", "plugin-manifest.json");
const SDK = path.join(ROOT, "public", "vendor", "exotel-websdk.bundle.js");
const OUT = path.join(ROOT, "out", "zoho-cti-widget.zip");

// zlib.crc32 arrived in Node 20.15 / 22.2; fall back to a table for older.
const crc32 = zlib.crc32 || ((buf) => {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
});

function zip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const packed = zlib.deflateRawSync(e.data, { level: 9 });
    const deflate = packed.length < e.data.length;
    const body = deflate ? packed : e.data;
    const crc = crc32(e.data) >>> 0;
    const method = deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

if (!fs.existsSync(SDK)) {
  console.error("Missing public/vendor/exotel-websdk.bundle.js. Run: npm run build:sdk");
  process.exit(1);
}

// Zoho's own packer (zet) puts the pages in an app/ folder and serves that
// folder as the widget's root. The same files also sit at the top level, so
// the index page /cti.html resolves however Zoho reads the zip.
const web = fs.readdirSync(APP)
  .filter((f) => fs.statSync(path.join(APP, f)).isFile())
  .map((f) => ({ name: f, data: fs.readFileSync(path.join(APP, f)) }));
web.push({ name: "exotel-websdk.bundle.js", data: fs.readFileSync(SDK) });
// history.html is cti.html that opens on the call history, and phone.html
// is cti.html as the Phone tab.
const cti = web.find((e) => e.name === "cti.html");
const variant = (name, attrs) => {
  const html = cti.data.toString("utf8");
  if (!html.includes('<body class="cti">')) throw new Error(`cti.html has no <body class="cti"> for ${name}`);
  web.push({ name, data: Buffer.from(html.replace('<body class="cti">', `<body class="cti" ${attrs}>`)) });
};
variant("history.html", 'data-view="history"');
variant("phone.html", 'data-host="tab"');
const entries = [
  ...web.map((e) => ({ name: "app/" + e.name, data: e.data })),
  ...web,
  { name: "plugin-manifest.json", data: fs.readFileSync(MANIFEST) },
];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const buf = zip(entries);
fs.writeFileSync(OUT, buf);
console.log(`\n  Built ${path.relative(ROOT, OUT)} (${(buf.length / 1024).toFixed(0)} KB, ${entries.length} files)`);
for (const e of entries) console.log(`    ${e.name}`);
console.log("\n  Index pages: /cti.html (Call button), /phone.html (Phone tab), /history.html (Call history button), /admin.html (CTI Admin tab)");

// The three Zoho functions as whole functions, first line included, ready
// to paste into Zoho's function editor.
const FUNCS = path.join(ROOT, "zoho-cti", "functions");
const PASTE = path.join(ROOT, "out", "zoho-functions");
fs.mkdirSync(PASTE, { recursive: true });
for (const name of ["cti_api", "cti_webhook", "cti_route"]) {
  const body = fs.readFileSync(path.join(FUNCS, `${name}.dg`), "utf8").replace(/\r\n/g, "\n").replace(/\s+$/, "");
  fs.writeFileSync(path.join(PASTE, `${name}.txt`), `string standalone.${name}(Map crmAPIRequest)\n{\n${body}\n}\n`);
}
console.log(`  Functions to paste: ${path.relative(ROOT, PASTE)}${path.sep}cti_api.txt, cti_webhook.txt, cti_route.txt\n`);
