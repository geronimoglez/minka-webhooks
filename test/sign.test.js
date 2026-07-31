// test/sign.test.js — Tokens firmados (lib/sign.js).
// Corre: `node test/sign.test.js`. Exit 1 si falla algo. Sin deps.
//
// Este módulo es lo único que impide que alguien adjunte documentos al expediente de otra persona:
// los ids de lead son enteros consecutivos, así que sin firma bastaría con cambiar ?t=41 por ?t=42.
// La spec lo pide explícitamente ("los datos personales no viajan en la URL"), con dos escenarios:
// token manipulado y fail-closed sin secreto. Aquí se fijan los dos, y algunos más.

const sign = require("../lib/sign.js");

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

const S = "secreto-de-pruebas-largo";
const OTRO = "otro-secreto-distinto";

// A: ida y vuelta
{
  const t = sign.issue(41, { secret: S });
  const v = sign.verify(t, { secret: S });
  check(v.ok === true && v.leadId === 41, "A: un token recién emitido se verifica y devuelve su lead");
  check(v.paid === false, "A: por defecto el token NO viene marcado como pagado");
  const p = sign.verify(sign.issue(41, { secret: S, paid: true }), { secret: S });
  check(p.ok === true && p.paid === true, "A: el estado 'pagado' viaja firmado dentro del token");
  check(!t.includes("@"), "A: el token no contiene datos personales, sólo el id y la caducidad");
}

// B: EL ESCENARIO DE LA SPEC — cambiar el lead del token lo invalida
{
  const t41 = sign.issue(41, { secret: S });
  const t42 = sign.issue(42, { secret: S });
  const partes41 = t41.split(".");
  const partes42 = t42.split(".");

  // sustituir el id por el de otro lead, dejando la firma original
  const forjado = [partes41[0], "42", partes41[2], partes41[3], partes41[4]].join(".");
  const v = sign.verify(forjado, { secret: S });
  check(v.ok === false && v.reason === "bad-signature",
    "B: cambiar ?t=41 por el lead 42 se rechaza (no se puede tocar el expediente de otro)");

  // pegar la firma del lead 42 sobre el payload del 41
  const mezclado = [...partes41.slice(0, 4), partes42[4]].join(".");
  check(sign.verify(mezclado, { secret: S }).ok === false, "B: mezclar la firma de otro token tampoco pasa");

  // auto-ascenderse a "pagado"
  const pagadoFalso = [partes41[0], partes41[1], "1", partes41[3], partes41[4]].join(".");
  check(sign.verify(pagadoFalso, { secret: S }).ok === false,
    "B: marcarse a sí mismo como pagado invalida la firma");

  // estirar la caducidad
  const eterno = [partes41[0], partes41[1], partes41[2], String(Date.now() + 1e12), partes41[4]].join(".");
  check(sign.verify(eterno, { secret: S }).ok === false, "B: estirar la caducidad invalida la firma");
}

// C: EL OTRO ESCENARIO DE LA SPEC — fail-closed sin secreto configurado
{
  let lanzo = false;
  try { sign.issue(1, { secret: "" }); } catch (e) { lanzo = e.message === "sign-no-secret"; }
  check(lanzo, "C: sin secreto no se EMITE ningún token");
  const t = sign.issue(1, { secret: S });
  check(sign.verify(t, { secret: "" }).reason === "no-secret", "C: sin secreto no se ACEPTA ningún token");
  check(sign.verify(t, {}).reason === "no-secret", "C: sin opciones tampoco se acepta");
  check(sign.verify(t, { secret: OTRO }).reason === "bad-signature", "C: con otro secreto no valida");
}

// D: caducidad
{
  const vencido = sign.issue(7, { secret: S, ttlMs: -1 });
  check(sign.verify(vencido, { secret: S }).reason === "expired", "D: un token vencido se rechaza");
  const t = sign.issue(7, { secret: S, ttlMs: 1000, now: 1_000_000 });
  check(sign.verify(t, { secret: S, now: 1_000_500 }).ok === true, "D: dentro de la ventana sí vale");
  check(sign.verify(t, { secret: S, now: 1_002_000 }).reason === "expired", "D: pasada la ventana ya no");
  check(sign.TTL_MS === 7 * 24 * 60 * 60 * 1000, "D: la ventana por defecto es de 7 días");
}

// E: entradas mal formadas — ninguna debe reventar ni colarse
{
  for (const malo of ["", null, undefined, "abc", "1.2.3", "1.2.3.4.5.6", "....", "2.x.0.999.sig",
                      "3.1.0.999.sig", "2.1.9.999.sig", "1.0.999.sig", "2.-1.0.999.sig"]) {
    const v = sign.verify(malo, { secret: S });
    check(v.ok === false, `E: rechaza ${JSON.stringify(malo)} (${v.reason})`);
  }
  for (const malo of [0, -1, 1.5, NaN, "abc", null]) {
    let lanzo = false;
    try { sign.issue(malo, { secret: S }); } catch (e) { lanzo = e.message === "sign-bad-lead"; }
    check(lanzo, `E: no emite token para un lead inválido ${JSON.stringify(malo)}`);
  }
}

// F: compatibilidad hacia atrás — los tokens v1 ya emitidos siguen valiendo (duran 7 días)
{
  const crypto = require("crypto");
  const payload = `1.55.${Date.now() + 60_000}`;
  const firma = crypto.createHmac("sha256", S).update(payload).digest("base64url");
  const v1 = `${payload}.${firma}`;
  const v = sign.verify(v1, { secret: S });
  check(v.ok === true && v.leadId === 55, "F: un token v1 emitido antes del cambio sigue siendo válido");
  check(v.paid === false, "F: un token v1 nunca cuenta como pagado");
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
