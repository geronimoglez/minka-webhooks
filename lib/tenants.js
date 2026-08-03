// Registro de cuentas que atiende el copiloto. Un solo endpoint sirve a todas: el webhook de
// Meta trae en `entry[].id` el id de la cuenta comentada, y de ahí sale el tenant.
//
// La alternativa —una URL de webhook por cliente— multiplica configuración en la consola de
// Meta y no gana nada.
//
// ─── Cómo se configura ──────────────────────────────────────────────────────────────────
//
// IG_COPILOTO_TENANTS = JSON, un objeto por id de cuenta de Instagram:
//
//   {
//     "17841400000000000": {
//       "clave": "juanelo",              // corta y estable: viaja en el callback_data
//       "handle": "tallerjuanelo",
//       "negocio": "Taller mecánico en Xalapa, servicio a domicilio",
//       "tokenEnv": "IG_TOKEN_JUANELO",  // NOMBRE de la variable, nunca el token
//       "chatId": "12345678",            // dónde aprueba ESTE dueño
//       "voz": "Escribes como Juan, el dueño: directo, sin tecnicismos, con humor de taller.",
//       "reglas": ["nunca prometer plazos de entrega", "no hablar de precios de refacciones"]
//     }
//   }
//
// El token va en su PROPIA variable de entorno a propósito: un blob JSON con todos los tokens
// adentro se acaba imprimiendo entero en un log algún día, y ahí se van todas las cuentas de
// una. Además así se rota una sin tocar las demás.
//
// Sin IG_COPILOTO_TENANTS configurado, se opera en modo de cuenta única con las variables
// heredadas (IG_ACCESS_TOKEN / IG_USER_ID / TELEGRAM_CHAT_ID) — @minka.one sigue igual.

const VOZ_MINKA =
  "Escribes como Gerónimo González, el fundador: directo, cálido, con humor seco, sin jerga " +
  "y sin vender de más.";

const MINKA = {
  clave: "minka",
  handle: "minka.one",
  negocio: "Minka Digital: automatización de atención y contenido con IA para PyMEs en México",
  tokenEnv: "IG_ACCESS_TOKEN",
  chatId: null, // null → cae al TELEGRAM_CHAT_ID del entorno
  voz: VOZ_MINKA,
  reglas: [],
};

function leerRegistro() {
  const crudo = process.env.IG_COPILOTO_TENANTS;
  if (!crudo || !crudo.trim()) return null;
  try {
    const obj = JSON.parse(crudo);
    return obj && typeof obj === "object" && Object.keys(obj).length ? obj : null;
  } catch (e) {
    // Fail-closed: con el registro roto NO se cae al tenant por defecto — se publicaría en la
    // cuenta equivocada, que es exactamente el daño que el aislamiento existe para evitar.
    console.error("tenants: IG_COPILOTO_TENANTS no es JSON válido —", e.message);
    return {};
  }
}

function normalizar(id, cfg) {
  const t = {
    id: String(id),
    // La clave viaja en el callback_data, que se parsea partiendo por ":" — un ":" adentro
    // correría los campos y el botón actuaría sobre otro comentario.
    clave: String(cfg.clave || id).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24),
    handle: cfg.handle || "",
    negocio: cfg.negocio || "",
    tokenEnv: cfg.tokenEnv || "",
    chatId: cfg.chatId ? String(cfg.chatId) : null,
    voz: cfg.voz || "",
    reglas: Array.isArray(cfg.reglas) ? cfg.reglas.map(String) : [],
  };
  // El token va no-enumerable: el objeto tenant circula por logs y prompts, y un
  // JSON.stringify descuidado —hoy o dentro de seis meses— lo imprimiría entero.
  Object.defineProperty(t, "token", {
    value: t.tokenEnv ? process.env[t.tokenEnv] || "" : "",
    enumerable: false, writable: false,
  });
  return t;
}

/**
 * Tenant por id de cuenta de Instagram. null = no atendemos esa cuenta.
 *
 * ⚠️ Una cuenta tiene DOS ids y Meta no siempre manda el mismo:
 *   /me?fields=id,user_id  →  id: 28713… (app-scoped)   user_id: 17841… (cuenta profesional)
 * Cuál llega en `entry[].id` depende del flujo de login y de la versión del webhook. Por eso
 * el registro admite **las dos claves apuntando a la misma config** — se sacan las dos de
 * `/me` al dar de alta al cliente y se registran ambas. Cuesta dos líneas de JSON y evita que
 * el copiloto quede mudo por un id que no empataba.
 */
function porCuenta(igUserId) {
  const reg = leerRegistro();
  if (reg === null) {
    // Modo cuenta única heredado: se acepta la entrada tal cual, como venía funcionando. No se
    // filtra por IG_USER_ID a propósito — si el id que manda Meta fuera el otro de los dos, el
    // filtro dejaría al copiloto mudo en silencio, que es peor que el riesgo que evitaría. Y el
    // riesgo aquí es teórico: el body viene firmado por Meta y la app solo está suscrita a
    // nuestra propia cuenta. En cuanto hay registro (multi-tenant) sí se exige empate.
    return normalizar(process.env.IG_USER_ID || "unico", MINKA);
  }
  const cfg = reg[String(igUserId)];
  return cfg ? normalizar(igUserId, cfg) : null;
}

/** Tenant por su clave corta — la que viaja en el callback_data de los botones. */
function porClave(clave) {
  const reg = leerRegistro();
  if (reg === null) return normalizar(process.env.IG_USER_ID || "unico", MINKA);
  for (const [id, cfg] of Object.entries(reg)) {
    if (String(cfg.clave || id) === String(clave)) return normalizar(id, cfg);
  }
  return null;
}

module.exports = { porCuenta, porClave, MINKA };
