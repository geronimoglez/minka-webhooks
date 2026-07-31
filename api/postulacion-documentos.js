// POST /postulacion/documentos  (multipart/form-data)
//
// Los reconocimientos del postulante: diplomas, certificados, cartas, premios, fotos. Opcionales
// y flexibles a propósito — "manda lo que tengas".
//
// POR QUÉ VA APARTE DE LA FORMA, y no dentro de ella: sin JavaScript no se puede validar el peso
// de un archivo antes de mandarlo, y Vercel corta las peticiones de más de 4.5 MB ANTES de que
// nuestro código corra. Si los archivos viajaran con la forma, una foto pesada del celular tiraría
// un 413 opaco y la persona perdería TODO lo que escribió. Aquí lo peor que puede pasar es que
// falle la subida — la postulación ya está guardada.
//
// Sin video: pesan de más y no aportan al expediente. La página lo dice y ofrece WhatsApp.

const crm = require("../lib/crm");
const sign = require("../lib/sign");
const multipart = require("../lib/multipart");
const { config } = require("../lib/evento");

// Allowlist por tipo declarado Y por firma real del archivo. El content-type de una parte multipart
// lo elige el cliente, así que por sí solo no prueba nada; los magic bytes sí. Con las dos, un .exe
// renombrado a .jpg no entra al CRM.
const KINDS = [
  { mime: "image/jpeg", ext: "jpg", magic: [[0xff, 0xd8, 0xff]] },
  { mime: "image/png", ext: "png", magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  { mime: "application/pdf", ext: "pdf", magic: [[0x25, 0x50, 0x44, 0x46]] },
  { mime: "image/webp", ext: "webp", magic: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF….WEBP
  { mime: "image/heic", ext: "heic", magic: [[0x66, 0x74, 0x79, 0x70]], offset: 4 }, // ….ftyp
];

function sniff(buf) {
  for (const k of KINDS) {
    for (const m of k.magic) {
      const off = k.offset || 0;
      if (buf.length >= off + m.length && m.every((b, i) => buf[off + i] === b)) {
        if (k.mime === "image/webp" && buf.subarray(8, 12).toString("latin1") !== "WEBP") continue;
        return k;
      }
    }
  }
  return null;
}

const back = (res, token, params) => {
  const q = new URLSearchParams({ t: token, ...params }).toString();
  res.setHeader("Location", `/postulacion/gracias?${q}`);
  return res.status(303).end();
};

module.exports = async (req, res) => {
  const cfg = config();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Método no permitido");
  }

  let token = "";
  try {
    const raw = await multipart.rawBody(req);
    const { fields, files } = multipart.parse(raw, req.headers["content-type"]);

    // El token va DENTRO del cuerpo, así que se valida después de parsear. Sin token válido no se
    // toca el CRM: es lo único que impide que alguien adjunte documentos al expediente de otro
    // (los ids de lead son enteros consecutivos y adivinables).
    token = String(fields.t || "");
    const v = sign.verify(token, { secret: process.env.POSTULACION_TOKEN_SECRET });
    if (!v.ok) {
      res.setHeader("Location", "/postulacion/gracias");
      return res.status(303).end();
    }

    const docs = files.filter((f) => f.field === "documentos");
    if (!docs.length) return back(res, token, { d: "err" });

    let guardados = 0;
    const stamp = new Date().toISOString().slice(0, 10);
    for (const [i, f] of docs.entries()) {
      const kind = sniff(f.data);
      // Se exige que la firma real coincida con lo que el navegador declaró.
      if (!kind || kind.mime !== String(f.mimetype).split(";")[0].trim().toLowerCase()) {
        return back(res, token, { d: "tipo" });
      }
      // El nombre lo ponemos NOSOTROS. El del cliente es texto arbitrario y sólo se usa como
      // etiqueta dentro de la nota, ya escapado por Odoo. La extensión sale de la firma real.
      const filename = `postulacion-${v.leadId}-${stamp}-${i + 1}.${kind.ext}`;
      const r = await crm.attachToLead(v.leadId, {
        filename,
        mimetype: kind.mime,
        base64: f.data.toString("base64"),
        note: `Documento de trayectoria adjuntado por el postulante: ${filename}`,
      }, { tenant: cfg.tenant });
      if (r.ok) guardados++;
    }

    if (!guardados) return back(res, token, { d: "err" });
    return back(res, token, { d: "ok", n: String(guardados) });
  } catch (e) {
    const m = String(e && e.message);
    const code = m === "multipart-file-too-large" || m === "multipart-too-large" ? "big"
      : m === "multipart-too-many-files" ? "many"
      : "err";
    if (token) return back(res, token, { d: code });
    res.setHeader("Location", "/postulacion/gracias");
    return res.status(303).end();
  }
};

module.exports.__sniff = sniff;
