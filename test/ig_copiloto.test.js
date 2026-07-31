// Tests del copiloto de comentarios de Instagram. Sin deps: `node test/ig_copiloto.test.js`.
//
// Cubre las tres cosas que, si fallan, publican algo indebido con la cara de la marca:
// la firma del webhook, la compuerta de automatización y el fail-closed del secreto.

const assert = require("assert");
const crypto = require("crypto");

let pasados = 0;
const resultado = (nombre) => [
  () => { pasados++; console.log(`  ok  ${nombre}`); },
  (e) => { console.error(`  FALLA  ${nombre}\n        ${e.message}`); process.exitCode = 1; },
];

function prueba(nombre, fn) {
  const [ok, falla] = resultado(nombre);
  try { fn(); ok(); } catch (e) { falla(e); }
}

// Las pruebas async se ENCOLAN, no se disparan al vuelo: varias corriendo a la vez se pisan
// el stub de global.fetch entre ellas y el resultado depende de quién termine primero.
// (Y si no se esperan, una prueba async "pasa" siempre aunque reviente.)
let cola = Promise.resolve();
function pruebaAsync(nombre, fn) {
  const [ok, falla] = resultado(nombre);
  cola = cola.then(fn).then(ok, falla);
}

// ─── Firma del webhook ────────────────────────────────────────────────────
process.env.IG_APP_SECRET = "secreto-de-prueba";
const ig = require("../lib/ig");

const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ field: "comments" }] }] }));
const firmaOk =
  "sha256=" + crypto.createHmac("sha256", "secreto-de-prueba").update(body).digest("hex");

console.log("\nFirma del webhook (el endpoint es público: es la única barrera)");
prueba("acepta la firma correcta", () => assert.strictEqual(ig.firmaValida(body, firmaOk), true));
prueba("rechaza una firma falsa del mismo largo", () => {
  const falsa = "sha256=" + "0".repeat(64);
  assert.strictEqual(ig.firmaValida(body, falsa), false);
});
prueba("rechaza si no viene el header", () =>
  assert.strictEqual(ig.firmaValida(body, undefined), false));
prueba("rechaza firma de largo distinto sin reventar", () =>
  assert.strictEqual(ig.firmaValida(body, "sha256=ab"), false));
prueba("rechaza si el body cambió aunque la firma sea válida para otro body", () => {
  const otro = Buffer.from(JSON.stringify({ entry: [] }));
  assert.strictEqual(ig.firmaValida(otro, firmaOk), false);
});

// ─── Compuerta de automatización ──────────────────────────────────────────
const copiloto = require("../lib/copiloto");
const decidir = (arquetipo, confianza, borrador = "texto") =>
  copiloto.decidir({ arquetipo, confianza, borrador });

console.log("\nCompuerta: automático SOLO donde el downside es cero");
prueba("elogio con confianza alta se responde solo", () =>
  assert.strictEqual(decidir("elogio", 0.9).modo, "auto"));
prueba("elogio con confianza dudosa baja a borrador", () =>
  assert.strictEqual(decidir("elogio", 0.6).modo, "borrador"));
prueba("escéptico nunca es automático (toca el giro del cliente)", () =>
  assert.strictEqual(decidir("esceptico", 0.99).modo, "borrador"));
prueba("escéptico con confianza baja escala a manual", () =>
  assert.strictEqual(decidir("esceptico", 0.3).modo, "manual"));
prueba("precio nunca es automático", () =>
  assert.strictEqual(decidir("precio", 0.99).modo, "borrador"));
prueba("un lead siempre es manual, por confiado que esté el modelo", () =>
  assert.strictEqual(decidir("lead", 1).modo, "manual"));
prueba("miedo al reemplazo siempre es manual", () =>
  assert.strictEqual(decidir("miedo", 1).modo, "manual"));
prueba("spam se oculta solo", () => {
  const d = decidir("spam", 0.95);
  assert.strictEqual(d.modo, "auto");
  assert.strictEqual(d.accion, "ocultar");
});
prueba("arquetipo inventado por el modelo cae a manual", () =>
  assert.strictEqual(decidir("loquesea", 0.99).modo, "manual"));
prueba("sin borrador no se publica nada automático", () =>
  assert.strictEqual(decidir("elogio", 0.99, null).modo, "manual"));
prueba("confianza ausente se trata como cero", () =>
  assert.strictEqual(copiloto.decidir({ arquetipo: "elogio", borrador: "x" }).modo, "manual"));

// ─── Fail-closed del secreto de Telegram ──────────────────────────────────
// Regla del repo: "rechazar si el secreto está vacío — nunca if(!SECRET) return true".
console.log("\nFail-closed del endpoint de acciones");
const fuente = require("fs").readFileSync(require("path").join(__dirname, "../api/ig-accion.js"), "utf8");
prueba("rechaza cuando TELEGRAM_WEBHOOK_SECRET no está configurado", () =>
  assert.ok(/if \(!SECRET \|\|/.test(fuente),
    "la guarda debe empezar con !SECRET, si no un secreto vacío deja pasar a cualquiera"));

// ─── Análisis degrada a manual si falla el LLM ────────────────────────────
console.log("\nDegradación del clasificador");
pruebaAsync("sin OPENROUTER_API_KEY el análisis cae a manual y no inventa borrador", async () => {
  const guardado = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const r = await copiloto.analizar("hola", "");
  if (guardado) process.env.OPENROUTER_API_KEY = guardado;
  assert.strictEqual(r.arquetipo, "lead");
  assert.strictEqual(r.borrador, null);
});

// ─── Fail-closed del handshake de Meta ────────────────────────────────────
// Sin IG_VERIFY_TOKEN, un `hub.verify_token=` vacío coincidía con la variable vacía y
// cualquiera completaba el handshake. Detectado en el deploy real.
console.log("\nFail-closed del handshake");
const src = require("fs").readFileSync(require("path").join(__dirname, "../api/ig-comments.js"), "utf8");
prueba("el handshake exige que IG_VERIFY_TOKEN exista", () =>
  assert.ok(/if \(ig\.VERIFY_TOKEN &&/.test(src),
    "la condición debe empezar exigiendo VERIFY_TOKEN no vacío"));

// ─── El trabajo ocurre ANTES de responder ─────────────────────────────────
// Bug real (2026-07-31): los endpoints contestaban 200 y "después" trabajaban. En serverless
// contestar TERMINA la invocación: lo pendiente se congela sin log, sin error y sin rastro. El
// webhook devolvía 200 impecable y no pasaba absolutamente nada. Estos tests lo fijan.
console.log("\nEl trabajo ocurre ANTES de contestar (el bug del agujero negro)");

process.env.TELEGRAM_WEBHOOK_SECRET = "secreto-tg";
process.env.COPILOTO_BOT_TOKEN = "bot-de-prueba";
process.env.TELEGRAM_CHAT_ID = "42";
const accion = require("../api/ig-accion");

function resFalso(orden) {
  return {
    status(c) { orden.push(`status:${c}`); return this; },
    json() { orden.push("json"); return this; },
  };
}

pruebaAsync("/prueba manda la propuesta a Telegram antes del 200", async () => {
  const orden = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    orden.push(`telegram:${String(url).split("/").pop()}`);
    return { ok: true, json: async () => ({ ok: true }), text: async () => "" };
  };
  try {
    await accion(
      { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secreto-tg" },
        body: { message: { chat: { id: 7 }, text: "/prueba" } } },
      resFalso(orden)
    );
  } finally {
    global.fetch = original;
  }
  const primer200 = orden.indexOf("status:200");
  const envios = orden.filter((o) => o.startsWith("telegram:")).length;
  assert.strictEqual(envios, 2, `esperaba ayuda + propuesta, hubo ${envios}: ${orden.join(" → ")}`);
  assert.ok(primer200 > 0 && orden.slice(0, primer200).every((o) => o.startsWith("telegram:")),
    `el 200 salió antes del trabajo: ${orden.join(" → ")}`);
});

pruebaAsync("el botón de PRUEBA no toca Instagram", async () => {
  const urls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ ok: true }), text: async () => "" };
  };
  try {
    await accion(
      { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secreto-tg" },
        body: { callback_query: { id: "cb1", data: "send:PRUEBA", from: { username: "gero" },
          message: { message_id: 9, chat: { id: 7 }, text: "✍️ Borrador:\nhola" } } } },
      resFalso([])
    );
  } finally {
    global.fetch = original;
  }
  assert.ok(urls.every((u) => u.includes("api.telegram.org")),
    `la prueba llamó a Instagram: ${urls.join(", ")}`);
});

prueba("ningún endpoint contesta antes de agendar el trabajo", () => {
  const fs = require("fs"), path = require("path");
  for (const f of ["ig-accion.js", "ig-comments.js"]) {
    const t = fs.readFileSync(path.join(__dirname, "../api", f), "utf8");
    assert.ok(/if \(!agendar\(trabajo\)\) await trabajo;/.test(t),
      `${f}: el trabajo debe esperarse cuando la plataforma no se hace cargo`);
    assert.ok(!/res\.status\(200\)[^\n]*\n\n?\s*try \{/.test(t),
      `${f}: volvió el patrón "contesta 200 y después procesa" — en serverless eso no corre`);
  }
});

cola.then(() => {
  console.log(`\n${pasados} pruebas ok${process.exitCode ? " — CON FALLAS" : ""}\n`);
});
