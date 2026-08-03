// lib/multipart.js — parser de multipart/form-data, sin dependencias.
//
// Por qué a mano: este repo no tiene dependencias a propósito (sin build step, `node` a secas corre
// los tests). La única cosa que necesitamos de un parser es sacar los archivos que el postulante
// adjunta desde una forma nativa sin JavaScript, y eso cabe en ~80 líneas con tests que cubren el
// caso peligroso (contenido binario que contiene los mismos bytes que el delimitador).
//
// Límites: se aplican SIEMPRE, aunque el caller no los pase. La forma es pública y sin sesión, así
// que un cuerpo hostil no puede hacer crecer la memoria de la función serverless sin tope.
//
// Nota de plataforma: Vercel corta las peticiones a 4.5 MB antes de que llegue nuestro código, así
// que el tope real de subida es más chico que cualquier número que pongamos aquí. Los defaults
// están por debajo de ese techo para que el error lo demos NOSOTROS (con un mensaje útil y sin
// perder el resto del formulario) en vez de que la plataforma tire un 413 opaco.

const DEFAULTS = {
  maxFiles: 5,
  maxFileBytes: 3 * 1024 * 1024,   // 3 MB por archivo
  maxTotalBytes: 4 * 1024 * 1024,  // 4 MB en total (por debajo del techo de 4.5 MB de Vercel)
  maxFields: 40,
  maxFieldBytes: 16 * 1024,
};

// Lee el cuerpo crudo. En Vercel, el helper de Node ya consumió el stream y deja `req.body` como
// Buffer cuando el content-type NO es json ni urlencoded (justo nuestro caso). Fuera de Vercel
// —o si algún día cambia— se lee el stream. Nunca se acumula más de `limit`.
async function rawBody(req, limit = DEFAULTS.maxTotalBytes + 64 * 1024) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += b.length;
    if (total > limit) throw new Error("multipart-too-large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  return m ? (m[1] || m[2]).trim() : null;
}

// Corta el cuerpo en partes por el delimitador `\r\n--<boundary>`.
//
// Se antepone un CRLF sintético al cuerpo para que el PRIMER delimitador (que en el alambre no
// lleva CRLF delante) case con el mismo patrón que los demás; así hay un solo camino de código.
// El corte es por búsqueda de bytes, no por texto: un JPEG puede contener la secuencia del
// delimitador sin ser un delimitador, y sólo cuenta si va precedido de CRLF.
function split(buf, boundary) {
  const delim = Buffer.from("\r\n--" + boundary, "latin1");
  const data = Buffer.concat([Buffer.from("\r\n", "latin1"), buf]);
  const parts = [];

  // Un delimitador SÓLO es válido si después del boundary vienen CRLF (con padding opcional) o
  // "--" (cierre) — RFC 2046 §5.1.1. Sin esta comprobación, un archivo que por casualidad contenga
  // "\r\n--<boundary>" seguido de cualquier otra cosa se partiría a la mitad y subiríamos al CRM un
  // documento corrupto. Devuelve dónde empieza el contenido siguiente, o null si no es delimitador.
  const delimAt = (i) => {
    let j = i + delim.length;
    if (data[j] === 0x2d && data[j + 1] === 0x2d) return { end: j + 2, close: true };
    while (data[j] === 0x20 || data[j] === 0x09) j++; // transport padding
    if (data[j] === 0x0d && data[j + 1] === 0x0a) return { end: j + 2, close: false };
    if (data[j] === 0x0a) return { end: j + 1, close: false }; // tolerar LF suelto
    return null;
  };
  // Siguiente delimitador VÁLIDO desde `from` (saltando las coincidencias que sólo lo parecen).
  const nextDelim = (from) => {
    let i = data.indexOf(delim, from);
    while (i !== -1) {
      const d = delimAt(i);
      if (d) return { at: i, ...d };
      i = data.indexOf(delim, i + 1);
    }
    return null;
  };

  let d = nextDelim(0);
  if (!d) return parts;
  while (!d.close) {
    const next = nextDelim(d.end);
    if (!next) break; // cuerpo truncado → se descarta la parte incompleta
    parts.push(data.subarray(d.end, next.at));
    d = next;
  }
  return parts;
}

function headerValue(headers, name) {
  const re = new RegExp(`^${name}\\s*:\\s*(.*)$`, "im");
  const m = re.exec(headers);
  return m ? m[1].trim() : "";
}

function dispositionParam(disposition, key) {
  // filename*=UTF-8''... (RFC 5987) tiene prioridad sobre filename= si viene
  const ext = new RegExp(`${key}\\*\\s*=\\s*[^']*'[^']*'([^;]+)`, "i").exec(disposition);
  if (ext) { try { return decodeURIComponent(ext[1].trim()); } catch { /* cae al simple */ } }
  const m = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;]+))`, "i").exec(disposition);
  return m ? (m[1] !== undefined ? m[1] : m[2].trim()) : "";
}

// parse(buf, contentType, opts) → { fields, files }
//   fields: { [name]: string }           (el último gana si se repite)
//   files:  [{ field, filename, mimetype, data: Buffer }]
// Lanza Error con un token corto si el cuerpo excede los límites.
function parse(buf, contentType, opts = {}) {
  const lim = { ...DEFAULTS, ...opts };
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error("multipart-no-boundary");
  if (buf.length > lim.maxTotalBytes) throw new Error("multipart-too-large");

  const fields = Object.create(null);
  const files = [];
  let nFields = 0;
  let totalFileBytes = 0;

  for (const part of split(buf, boundary)) {
    const sep = part.indexOf("\r\n\r\n", 0, "latin1");
    if (sep === -1) continue; // parte sin cabeceras → se ignora
    const headers = part.subarray(0, sep).toString("utf8");
    const body = part.subarray(sep + 4);
    const disposition = headerValue(headers, "content-disposition");
    const name = dispositionParam(disposition, "name");
    if (!name) continue;
    const filename = dispositionParam(disposition, "filename");

    if (filename === "") {
      // campo de texto
      if (++nFields > lim.maxFields) throw new Error("multipart-too-many-fields");
      if (body.length > lim.maxFieldBytes) throw new Error("multipart-field-too-large");
      fields[name] = body.toString("utf8");
    } else {
      // Un <input type=file> vacío manda una parte con filename="" y 0 bytes → no es un archivo.
      if (body.length === 0) continue;
      if (files.length >= lim.maxFiles) throw new Error("multipart-too-many-files");
      if (body.length > lim.maxFileBytes) throw new Error("multipart-file-too-large");
      totalFileBytes += body.length;
      if (totalFileBytes > lim.maxTotalBytes) throw new Error("multipart-too-large");
      files.push({
        field: name,
        filename,
        mimetype: headerValue(headers, "content-type") || "application/octet-stream",
        data: body,
      });
    }
  }
  return { fields, files };
}

module.exports = { parse, rawBody, boundaryOf, DEFAULTS };
