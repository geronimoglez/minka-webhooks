// test/crm_tenant.test.js — Aislamiento multi-tenant de lib/crm.js.
// Corre: `node test/crm_tenant.test.js`. Exit 1 si falla algo. Sin deps: mockea global.fetch.
//
// La plataforma Odoo de Minka es multi-DB (una base por cliente). Estos tests fijan las
// propiedades que, si se rompen, mezclan los datos de un cliente con los de otro:
//
//  A: `credsFor` resuelve las ODOO_*_<TENANT> del tenant, y las ODOO_* globales sin tenant.
//  B: un tenant inválido se RECHAZA (no se normaliza en silencio hacia otro sufijo).
//  C: un tenant sin credenciales NO cae al tenant global — degrada a "none" sin tocar la red.
//  D: las escrituras viajan a la URL/DB/llave DEL TENANT.
//  E: el cache de ids de crm.stage está separado por tenant (los ids son por base de datos).
//  F: el cache de uid está separado por tenant.
//  G: noteOnce es idempotente por marca (el mismo cobro no deja dos notas).

process.env.ODOO_URL = "https://crm.minkadigital.com";
process.env.ODOO_DB = "crm";
process.env.ODOO_USER = "minka@x.com";
process.env.ODOO_API_KEY = "key-global";
process.env.ODOO_URL_JUANELO = "https://juanelo.crm.minkadigital.com";
process.env.ODOO_DB_JUANELO = "juanelo";
process.env.ODOO_USER_JUANELO = "juanelo@x.com";
process.env.ODOO_API_KEY_JUANELO = "key-juanelo";
process.env.ODOO_WAKE_RETRIES = "0";
delete process.env.CRM_DRIVER; // driver auto: se decide por las credenciales de cada tenant

const crm = require("../lib/crm.js");
const { credsFor, pushLead, noteOnce, tagLead, driver, __resetUid, __resetCaches } = crm;

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

// Odoo falso enrutado por contenido (no por secuencia fija): responde según el modelo/método que
// se le pide y recuerda todo lo que recibió, para poder afirmar A QUÉ BASE fue cada escritura.
function fakeOdoo({ stageIds = {}, existingMessages = {} } = {}) {
  const state = { rpc: [], ops: [], seqByDb: {} };
  const json = (result) => ({ status: 200, json: async () => ({ result }) });
  global.fetch = async (url, opts) => {
    const p = JSON.parse(opts.body).params;
    state.rpc.push({ url, service: p.service, method: p.method });
    if (p.service === "common" && p.method === "authenticate") {
      const [db, user, key] = p.args;
      state.ops.push({ kind: "auth", url, db, user, key });
      return json({ crm: 1, juanelo: 2 }[db] ?? 99);
    }
    const [db, uid, key, model, method, args, kwargs] = p.args;
    state.ops.push({ kind: "exec", url, db, uid, key, model, method, args, kwargs });
    state.seqByDb[db] = (state.seqByDb[db] || 100) + 1;
    if (model === "crm.stage" && method === "search") {
      const name = args[0][0][2];
      const id = (stageIds[db] || {})[name];
      return json(id ? [id] : []);
    }
    if (model === "mail.message" && method === "search") return json(existingMessages[db] || []);
    if (method === "search") return json([]);      // sin match → fuerza create (no dedup)
    return json(state.seqByDb[db]);                // create / write / message_post
  };
  return state;
}

const opsTo = (st, db) => st.ops.filter((o) => o.db === db);
const created = (st, db, model) =>
  st.ops.filter((o) => o.db === db && o.model === model && o.method === "create").map((o) => o.args[0]);

async function main() {
  // A: resolución de credenciales por tenant
  {
    const g = credsFor("");
    check(g.db === "crm" && g.apiKey === "key-global" && g.url === "https://crm.minkadigital.com",
      "A: sin tenant → las ODOO_* globales");
    const j = credsFor("juanelo");
    check(j.db === "juanelo" && j.apiKey === "key-juanelo" && j.url === "https://juanelo.crm.minkadigital.com",
      "A: tenant juanelo → las ODOO_*_JUANELO");
    process.env.ODOO_DB_DOS_PALABRAS = "dos-palabras";
    check(credsFor("dos-palabras").db === "dos-palabras", "A: el guión del slug mapea a _ en el sufijo");
    check(credsFor("").url === "https://crm.minkadigital.com" &&
      credsFor("juanelo").url.endsWith("minkadigital.com"), "A: la URL se normaliza sin barra final");
  }

  // B: tenant inválido → se rechaza (nunca se normaliza hacia otro sufijo)
  {
    for (const bad of ["../crm", "JUANELO", "a", "x".repeat(41), "-juanelo", "juanelo-", "jua nelo", "URL"]) {
      let threw = false;
      try { credsFor(bad); } catch (e) { threw = e.message === "crm-bad-tenant"; }
      check(threw, `B: rechaza el tenant inválido ${JSON.stringify(bad)}`);
    }
    const st = fakeOdoo();
    const r = await pushLead({ nombre: "X", email: "x@y.com" }, { tenant: "../crm" });
    check(r.ok === false && r.detail === "crm-bad-tenant", "B: pushLead con tenant inválido → detail saneado");
    check(st.rpc.length === 0, "B: tenant inválido NO genera ni una llamada de red");
  }

  // C: tenant válido SIN credenciales → NO cae al global. Es la propiedad que evita que los
  //    postulantes de un cliente aterricen en el CRM de Minka.
  {
    __resetCaches();
    const st = fakeOdoo();
    check(driver("sincreds") === "none", "C: tenant sin ODOO_*_<T> → driver none (no hereda del global)");
    const r = await pushLead({ nombre: "Ana", email: "ana@x.com" }, { tenant: "sincreds" });
    check(r.ok === false && r.driver === "none", "C: pushLead degrada honesto");
    check(st.rpc.length === 0, "C: cero llamadas de red → NUNCA escribe en la base global");
  }

  // D: la escritura viaja a la URL / DB / llave DEL TENANT
  {
    __resetCaches();
    const st = fakeOdoo({ stageIds: { juanelo: { Nuevo: 11 } } });
    const r = await pushLead(
      { nombre: "Rosa", email: "rosa@x.com", whatsapp: "+52 33 1111 1111", negocio: "Estética Rosa" },
      { tenant: "juanelo", tags: ["postulacion"], note: "hola" });
    check(r.ok === true, "D: pushLead al tenant responde ok");
    check(opsTo(st, "crm").length === 0, "D: CERO operaciones contra la base global `crm`");
    check(opsTo(st, "juanelo").length > 0, "D: las operaciones van contra la base `juanelo`");
    check(st.ops.every((o) => o.url === "https://juanelo.crm.minkadigital.com/jsonrpc"),
      "D: todas las peticiones van a la URL del tenant");
    check(st.ops.every((o) => o.key === "key-juanelo"), "D: todas usan la llave del tenant");
    check(st.ops.filter((o) => o.kind === "exec").every((o) => o.uid === 2), "D: usan el uid de la base del tenant");
    const partner = created(st, "juanelo", "res.partner")[0];
    check(partner && partner.email === "rosa@x.com", "D: el contacto se crea en la base del tenant");
  }

  // E: REGRESIÓN de aislamiento — los ids de crm.stage son POR BASE. Con un cache global, el
  //    segundo tenant heredaría el id del primero y escribiría en una etapa de otra base.
  {
    __resetCaches();
    const st = fakeOdoo({ stageIds: { juanelo: { Nuevo: 11 }, crm: { Nuevo: 3 } } });
    await pushLead({ nombre: "A", email: "a@x.com" }, { tenant: "juanelo", tags: ["postulacion"] });
    await pushLead({ nombre: "B", email: "b@x.com" }, { tags: ["postulacion"] }); // tenant global
    const leadJ = created(st, "juanelo", "crm.lead")[0];
    const leadG = created(st, "crm", "crm.lead")[0];
    check(leadJ && leadJ.stage_id === 11, "E: el lead de juanelo usa la etapa 11 (id de SU base)");
    check(leadG && leadG.stage_id === 3, "E: el lead global usa la etapa 3 (id de la base global)");
    check(leadJ.stage_id !== leadG.stage_id, "E: los ids de etapa NO se filtran entre tenants");
    const stageSearches = st.ops.filter((o) => o.model === "crm.stage" && o.method === "search");
    check(stageSearches.length === 2, "E: cada tenant resuelve su propia etapa (2 búsquedas, no 1)");
  }

  // E2: los leads de postulación caen en el pipeline del CLIENTE ("Nuevo"), no en la etapa por
  //     defecto en inglés que trae la plantilla de Odoo.
  {
    __resetCaches();
    const st = fakeOdoo({ stageIds: { juanelo: { Nuevo: 20, New: 1 } } });
    await pushLead({ nombre: "A", email: "a@x.com" },
      { tenant: "juanelo", tags: ["postulacion", "iconos-belleza-iv"] });
    const buscada = st.ops.find((o) => o.model === "crm.stage" && o.method === "search").args[0][0][2];
    check(buscada === "Nuevo", "E2: una postulación busca la etapa 'Nuevo' del pipeline del cliente");
    check(created(st, "juanelo", "crm.lead")[0].stage_id === 20, "E2: y el lead se crea en esa etapa");
  }

  // F: cache de uid separado — cada base autentica por su cuenta
  {
    __resetCaches();
    const st = fakeOdoo();
    await pushLead({ nombre: "A", email: "a@x.com" }, { tenant: "juanelo" });
    await pushLead({ nombre: "B", email: "b@x.com" }, {});
    const auths = st.ops.filter((o) => o.kind === "auth");
    check(auths.length === 2, "F: dos tenants → dos authenticate (el uid no se reusa entre bases)");
    check(auths[0].db === "juanelo" && auths[1].db === "crm", "F: cada authenticate va contra su base");
    // ...y dentro del mismo tenant el uid SÍ se cachea (no se paga el round-trip dos veces)
    const st2 = fakeOdoo();
    await pushLead({ nombre: "C", email: "c@x.com" }, { tenant: "juanelo" });
    check(st2.ops.filter((o) => o.kind === "auth").length === 0, "F: dentro del tenant el uid sí se reusa");
  }

  // G: noteOnce idempotente por marca — el mismo cobro no puede dejar dos notas en el lead
  {
    __resetCaches();
    const st = fakeOdoo();
    const r1 = await noteOnce(55, { tenant: "juanelo", body: "Apartado pagado cs_test_123", mark: "cs_test_123" });
    check(r1.ok === true && !r1.deduped, "G: la 1ª nota se escribe");
    const st2 = fakeOdoo({ existingMessages: { juanelo: [777] } });
    const r2 = await noteOnce(55, { tenant: "juanelo", body: "Apartado pagado cs_test_123", mark: "cs_test_123" });
    check(r2.ok === true && r2.deduped === true, "G: la 2ª nota con la misma marca se deduplica");
    check(st2.ops.filter((o) => o.method === "message_post").length === 0, "G: no hay segundo message_post");
    const rt = await tagLead(55, ["apartado-pagado"], { tenant: "juanelo" });
    check(rt.ok === true, "G: tagLead agrega el tag sin reescribir el lead");
  }

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main();
