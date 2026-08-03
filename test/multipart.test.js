// test/multipart.test.js — Parser de multipart/form-data (lib/multipart.js).
// Corre: `node test/multipart.test.js`. Exit 1 si falla algo. Sin deps.
//
// El caso que importa de verdad es el C: un archivo binario puede contener por casualidad los
// mismos bytes que el delimitador. Un parser que corte por texto parte el archivo a la mitad y
// sube basura al CRM. Aquí se prueba con contenido que lleva el delimitador embebido.

const { parse, boundaryOf, DEFAULTS } = require("../lib/multipart.js");

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}
function throwsWith(fn, token, label) {
  let msg = "";
  try { fn(); } catch (e) { msg = e.message; }
  check(msg === token, `${label} (${msg || "no lanzó"})`);
}

const B = "----TestBoundary9k2";
const CT = `multipart/form-data; boundary=${B}`;

// Arma un cuerpo multipart real a partir de una lista de partes.
//   {name, value}                      → campo de texto
//   {name, filename, type, data}       → archivo (data: Buffer | string)
function build(parts, boundary = B) {
  const chunks = [];
  for (const p of parts) {
    const disp = p.filename !== undefined
      ? `form-data; name="${p.name}"; filename="${p.filename}"`
      : `form-data; name="${p.name}"`;
    const type = p.filename !== undefined ? `\r\nContent-Type: ${p.type || "application/octet-stream"}` : "";
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}${type}\r\n\r\n`, "utf8"));
    const body = p.filename !== undefined ? p.data : p.value;
    chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

// A: campos de texto
{
  const body = build([
    { name: "nombre", value: "Rosa Martínez" },
    { name: "email", value: "rosa@ejemplo.mx" },
    { name: "trayectoria", value: "Línea 1\r\nLínea 2 — con acentos y guión largo" },
  ]);
  const { fields, files } = parse(body, CT);
  check(fields.nombre === "Rosa Martínez", "A: campo con acentos se decodifica como UTF-8");
  check(fields.email === "rosa@ejemplo.mx", "A: segundo campo");
  check(fields.trayectoria === "Línea 1\r\nLínea 2 — con acentos y guión largo", "A: CRLF interno del textarea se conserva");
  check(files.length === 0, "A: sin archivos");
}

// B: archivo simple + campo mezclados
{
  const pdf = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\nreconocimiento", "latin1");
  const body = build([
    { name: "nombre", value: "Ana" },
    { name: "documentos", filename: "diploma.pdf", type: "application/pdf", data: pdf },
  ]);
  const { fields, files } = parse(body, CT);
  check(fields.nombre === "Ana", "B: el campo de texto sobrevive junto al archivo");
  check(files.length === 1 && files[0].field === "documentos", "B: un archivo, en su campo");
  check(files[0].filename === "diploma.pdf" && files[0].mimetype === "application/pdf", "B: nombre y mimetype");
  check(files[0].data.equals(pdf), "B: los bytes del archivo llegan intactos");
}

// C: EL CASO PELIGROSO — contenido binario que CONTIENE los bytes del delimitador.
//    Sólo cuenta como delimitador si va precedido de CRLF; un parser ingenuo parte el archivo aquí.
{
  const evil = Buffer.concat([
    Buffer.from("JPEGSTART", "latin1"),
    Buffer.from(`--${B}`, "latin1"),            // delimitador SIN CRLF delante → NO es delimitador
    Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d]), // bytes crudos, incluido CRLF suelto
    Buffer.from(`\r\n--${B}x`, "latin1"),        // CRLF + casi-delimitador (sufijo extra) → tampoco
    Buffer.from("JPEGEND", "latin1"),
  ]);
  const body = build([{ name: "documentos", filename: "foto.jpg", type: "image/jpeg", data: evil }]);
  const { files } = parse(body, CT);
  check(files.length === 1, "C: el binario con el delimitador embebido NO se parte en varias partes");
  check(files[0].data.length === evil.length, "C: longitud exacta (no se truncó)");
  check(files[0].data.equals(evil), "C: bytes idénticos (no se corrompió)");
}

// D: <input type=file> vacío → el navegador manda filename="" y 0 bytes; no es un archivo
{
  const body = build([
    { name: "nombre", value: "Luis" },
    { name: "documentos", filename: "", type: "application/octet-stream", data: Buffer.alloc(0) },
  ]);
  const { fields, files } = parse(body, CT);
  check(files.length === 0, "D: input de archivo vacío no produce archivo");
  check(fields.nombre === "Luis", "D: el resto de la forma se procesa igual");
}

// E: varios archivos
{
  const body = build([
    { name: "documentos", filename: "a.png", type: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: "documentos", filename: "b.pdf", type: "application/pdf", data: Buffer.from("%PDF") },
    { name: "documentos", filename: "c.jpg", type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) },
  ]);
  const { files } = parse(body, CT);
  check(files.length === 3, "E: tres archivos en el mismo campo");
  check(files.map((f) => f.filename).join(",") === "a.png,b.pdf,c.jpg", "E: en orden");
}

// F: nombres de archivo hostiles / con UTF-8
{
  const body = build([
    { name: "documentos", filename: "reconocimiento año; 2025.pdf", type: "application/pdf", data: Buffer.from("x") },
  ]);
  const { files } = parse(body, CT);
  check(files[0].filename === "reconocimiento año; 2025.pdf", "F: filename entrecomillado con ; y acentos");
}
{
  const raw = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="d"; filename*=UTF-8''premio%20a%C3%B1o.pdf\r\n\r\n`, "utf8"),
    Buffer.from("x"), Buffer.from(`\r\n--${B}--\r\n`, "utf8"),
  ]);
  const { files } = parse(raw, CT);
  check(files[0] && files[0].filename === "premio año.pdf", "F: filename* (RFC 5987) se decodifica");
}

// G: límites — se aplican siempre, la forma es pública y sin sesión
{
  const many = Array.from({ length: DEFAULTS.maxFiles + 1 }, (_, i) =>
    ({ name: "documentos", filename: `f${i}.png`, type: "image/png", data: Buffer.from("x") }));
  throwsWith(() => parse(build(many), CT), "multipart-too-many-files", "G: corta al exceder maxFiles");

  const big = [{ name: "d", filename: "grande.jpg", type: "image/jpeg", data: Buffer.alloc(DEFAULTS.maxFileBytes + 1) }];
  throwsWith(() => parse(build(big), CT), "multipart-file-too-large", "G: corta un archivo por encima de maxFileBytes");

  const bigField = [{ name: "t", value: "x".repeat(DEFAULTS.maxFieldBytes + 1) }];
  throwsWith(() => parse(build(bigField), CT), "multipart-field-too-large", "G: corta un campo de texto enorme");

  const huge = Buffer.alloc(DEFAULTS.maxTotalBytes + 1);
  throwsWith(() => parse(huge, CT), "multipart-too-large", "G: corta por tamaño total antes de parsear");

  const manyFields = Array.from({ length: DEFAULTS.maxFields + 1 }, (_, i) => ({ name: `f${i}`, value: "v" }));
  throwsWith(() => parse(build(manyFields), CT), "multipart-too-many-fields", "G: corta al exceder maxFields");
}

// H: content-type sin boundary → error explícito (no un parseo silencioso a vacío)
{
  throwsWith(() => parse(build([{ name: "a", value: "b" }]), "multipart/form-data"), "multipart-no-boundary",
    "H: sin boundary lanza");
  check(boundaryOf(`multipart/form-data; boundary="con espacios"`) === "con espacios", "H: boundary entrecomillado");
  check(boundaryOf(`multipart/form-data; boundary=${B}; charset=utf-8`) === B, "H: boundary con parámetros después");
}

// I: cuerpo truncado (conexión cortada a media subida) → no revienta, descarta la parte incompleta
{
  const full = build([
    { name: "nombre", value: "Ok" },
    { name: "documentos", filename: "corta.bin", type: "application/octet-stream", data: Buffer.alloc(500, 7) },
  ]);
  const truncated = full.subarray(0, full.length - 120);
  const { fields, files } = parse(truncated, CT);
  check(fields.nombre === "Ok", "I: los campos completos anteriores se conservan");
  check(files.length === 0, "I: la parte truncada se descarta (no se sube basura)");
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
