// Tests del copiloto de comentarios de Instagram. Sin deps: `node test/ig_copiloto.test.js`.
//
// Cubre las tres cosas que, si fallan, publican algo indebido con la cara de la marca:
// la firma del webhook, la compuerta de automatización y el fail-closed del secreto.

const assert = require("assert");
const crypto = require("crypto");

let pasados = 0;
function prueba(nombre, fn) {
  try {
    fn();
    pasados++;
    console.log(`  ok  ${nombre}`);
  } catch (e) {
    console.error(`  FALLA  ${nombre}\n        ${e.message}`);
    process.exitCode = 1;
  }
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
prueba("sin OPENROUTER_API_KEY el análisis cae a manual y no inventa borrador", async () => {
  const guardado = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const r = await copiloto.analizar("hola", "");
  if (guardado) process.env.OPENROUTER_API_KEY = guardado;
  assert.strictEqual(r.arquetipo, "lead");
  assert.strictEqual(r.borrador, null);
});

setTimeout(() => {
  console.log(`\n${pasados} pruebas ok${process.exitCode ? " — CON FALLAS" : ""}\n`);
}, 50);

// ─── Fail-closed del handshake de Meta ────────────────────────────────────
// Sin IG_VERIFY_TOKEN, un `hub.verify_token=` vacío coincidía con la variable vacía y
// cualquiera completaba el handshake. Detectado en el deploy real.
console.log("\nFail-closed del handshake");
const src = require("fs").readFileSync(require("path").join(__dirname, "../api/ig-comments.js"), "utf8");
prueba("el handshake exige que IG_VERIFY_TOKEN exista", () =>
  assert.ok(/if \(ig\.VERIFY_TOKEN &&/.test(src),
    "la condición debe empezar exigiendo VERIFY_TOKEN no vacío"));
