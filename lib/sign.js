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

// El estado "ya pagado" también va DENTRO del token (v2), no en un parámetro suelto de la URL.
// Si viviera en `?p=ok`, cualquiera podría escribirlo a mano y la pantalla de gracias diría "Lugar
// apartado" sin que exista el cobro — una pantalla que miente sobre un pago es peor que no tenerla,
// porque alguien la va a usar como comprobante.
//
// v1 ("1.<lead>.<exp>.<firma>") se sigue aceptando: los tokens ya emitidos duran 7 días y no hay
// razón para invalidarle la sesión a quien se postuló ayer. Un token v1 simplemente vale paid=false.

// issue(leadId) → "2.<leadId>.<0|1>.<exp>.<firma>"
function issue(leadId, { secret, ttlMs = TTL_MS, now = Date.now(), paid = false } = {}) {
  if (!secret) throw new Error("sign-no-secret");
  const id = Number(leadId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("sign-bad-lead");
  const payload = `2.${id}.${paid ? 1 : 0}.${now + ttlMs}`;
  return `${payload}.${hmac(payload, secret)}`;
}

// verify(token) → { ok:true, leadId, paid } | { ok:false, reason }
// `reason` es siempre un token diagnóstico corto (sin PII) apto para logs y para la respuesta.
function verify(token, { secret, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: "no-secret" }; // fail-closed
  const parts = String(token || "").split(".");
  let v, idStr, paidStr, expStr, sig;
  if (parts.length === 5) [v, idStr, paidStr, expStr, sig] = parts;
  else if (parts.length === 4) { [v, idStr, expStr, sig] = parts; paidStr = "0"; }
  else return { ok: false, reason: "malformed" };
  if (v !== "1" && v !== "2") return { ok: false, reason: "version" };
  if (v === "1" && parts.length !== 4) return { ok: false, reason: "malformed" };
  if (v === "2" && parts.length !== 5) return { ok: false, reason: "malformed" };
  const payload = parts.slice(0, -1).join(".");
  // La firma se verifica ANTES de confiar en cualquier campo (incluidas la caducidad y `paid`).
  if (!safeEq(sig, hmac(payload, secret))) return { ok: false, reason: "bad-signature" };
  const exp = Number(expStr);
  const id = Number(idStr);
  if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "malformed" };
  if (paidStr !== "0" && paidStr !== "1") return { ok: false, reason: "malformed" };
  if (now > exp) return { ok: false, reason: "expired" };
  return { ok: true, leadId: id, paid: paidStr === "1" };
}

module.exports = { issue, verify, TTL_MS };
