// lib/sign.js — tokens cortos firmados (HMAC-SHA256).
//
// Para qué: después de guardar la postulación, el navegador se va a la pantalla de gracias, que
// necesita saber A QUÉ LEAD pertenece (para cobrar el apartado y para adjuntarle documentos).
// Ese dato viaja en la URL.
//
// Por eso el token NO lleva datos personales: sólo el id numérico del lead y una caducidad. Poner
// el email o el nombre en la query string los dejaría en el historial del navegador, en el Referer
// hacia Stripe y en los logs de cualquier proxy intermedio.
//
// Y va FIRMADO porque el id del lead es un entero secuencial: sin firma, cualquiera podría cambiar
// `?t=41` por `?t=42` y adjuntarle documentos —o atribuirle un pago— al lead de otra persona.
//
// Fail-closed: sin secreto configurado no se emite ni se acepta ningún token.

const crypto = require("crypto");

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días: hay que poder volver a pagar al día siguiente

const hmac = (payload, secret) =>
  crypto.createHmac("sha256", secret).update(payload).digest("base64url");

// Comparación en tiempo constante. timingSafeEqual exige longitudes iguales, así que se compara
// primero la longitud (que no es secreta) y sólo después los bytes.
function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// issue(leadId) → "1.<leadId>.<exp>.<firma>"
function issue(leadId, { secret, ttlMs = TTL_MS, now = Date.now() } = {}) {
  if (!secret) throw new Error("sign-no-secret");
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("sign-bad-lead");
  const payload = `1.${id}.${now + ttlMs}`;
  return `${payload}.${hmac(payload, secret)}`;
}

// verify(token) → { ok:true, leadId } | { ok:false, reason }
// `reason` es siempre un token diagnóstico corto (sin PII) apto para logs y para la respuesta.
function verify(token, { secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: "no-secret" }; // fail-closed
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [v, idStr, expStr, sig] = parts;
  if (v !== "1") return { ok: false, reason: "version" };
  const payload = `${v}.${idStr}.${expStr}`;
  // La firma se verifica ANTES de confiar en cualquier campo (incluida la caducidad).
  if (!safeEq(sig, hmac(payload, secret))) return { ok: false, reason: "bad-signature" };
  const exp = Number(expStr);
  const id = Number(idStr);
  if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "malformed" };
  if (now > exp) return { ok: false, reason: "expired" };
  return { ok: true, leadId: id };
}

module.exports = { issue, verify, TTL_MS };
