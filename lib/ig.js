// Helpers de la API de Instagram (Instagram Login / graph.instagram.com).
//
// Sirve al copiloto de comentarios (api/ig-comments.js + api/ig-accion.js). Doctrina y
// taxonomía: repo MinkaDigital-mktAIDir → docs/instagram-moderacion-copiloto.md §MODO AUDIENCIA.
//
// La app es `minka-assistant` en Development Mode: como @minka.one es cuenta propia, NO
// requiere App Review. Para moderar cuentas de CLIENTES sí haría falta Advanced Access
// (Business Verification + App Review, 2-4 semanas).

const crypto = require("crypto");

const GRAPH = "https://graph.instagram.com/v23.0";

const TOKEN = process.env.IG_ACCESS_TOKEN || "";
const APP_SECRET = process.env.IG_APP_SECRET || "";
const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || "";

/**
 * Valida la firma del webhook. Meta firma el body crudo con el App Secret.
 *
 * Sin esto, CUALQUIERA que descubra la URL puede inyectar comentarios falsos y hacer que el
 * copiloto publique respuestas en la cuenta. Es la única barrera del endpoint: es público.
 */
function firmaValida(rawBody, header) {
  if (!APP_SECRET || !header) return false;
  const esperado =
    "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(header));
  // timingSafeEqual revienta si difieren en longitud: se compara antes.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function igFetch(path, { method = "GET", params = {}, token = TOKEN } = {}) {
  if (!token) throw new Error("IG: sin token para esta cuenta");
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = `${GRAPH}${path}?${qs}`;
  const r = await fetch(url, { method });
  const txt = await r.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt.slice(0, 300) };
  }
  if (!r.ok) {
    const e = new Error(json?.error?.message || `IG ${r.status}`);
    e.status = r.status;
    e.body = json;
    throw e;
  }
  return json;
}

/**
 * Cliente ligado a UNA cuenta. Multi-tenant: el token viaja por llamada, no por módulo — así
 * un evento de la cuenta A no puede terminar publicando con el token de B.
 */
function cliente(token) {
  const f = (path, opts = {}) => igFetch(path, { ...opts, token });

  /** Datos del comentario + el media donde vive (para dar contexto al clasificador). */
  const getComentario = (id) =>
    f(`/${id}`, { params: { fields: "id,text,username,timestamp,media{id,caption,permalink}" } });

  /** Responde EN EL HILO del comentario (no como comentario suelto). */
  const responder = (commentId, mensaje) =>
    f(`/${commentId}/replies`, { method: "POST", params: { message: mensaje } });

  /**
   * Oculta un comentario. Se OCULTA, no se borra: borrar suele escalar con el autor,
   * ocultar es invisible para él (doctrina §MODO AUDIENCIA).
   */
  const ocultar = (commentId) =>
    f(`/${commentId}`, { method: "POST", params: { hide: "true" } });

  /** Id del usuario de la cuenta, para descartar los comentarios propios. */
  const yo = () => f("/me", { params: { fields: "id,username,user_id" } });

  /**
   * ¿Ya respondimos este comentario? Se le pregunta a INSTAGRAM, no a memoria local.
   *
   * En serverless no hay estado confiable: cada arranque en frío estrena memoria, así que un
   * Map de "ya visto" no sirve para deduplicar. Y tanto Meta como Telegram reentregan, con lo
   * que el mismo comentario puede llegar dos veces y contestarse dos veces. La única fuente
   * de verdad que sobrevive a todo es el hilo mismo.
   *
   * Fail-closed: si la consulta falla, devuelve true (asume que ya se respondió) — es
   * preferible perder una respuesta a publicar duplicados con la cara de la marca.
   */
  async function yaRespondido(commentId, miUsuario) {
    try {
      const r = await f(`/${commentId}/replies`, { params: { fields: "id,username" } });
      return (r.data || []).some((x) => x.username === miUsuario);
    } catch (e) {
      console.error("yaRespondido: no se pudo verificar", e.message);
      return true;
    }
  }

  return { getComentario, responder, ocultar, yo, yaRespondido };
}

// La firma del webhook se valida con el App Secret, que es de la APP y no de la cuenta: es la
// misma para todos los tenants.
module.exports = { GRAPH, TOKEN, VERIFY_TOKEN, firmaValida, cliente, ...cliente(TOKEN) };
