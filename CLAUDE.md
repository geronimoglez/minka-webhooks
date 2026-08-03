# CLAUDE.md — minka-webhooks

Endpoints serverless (Vercel) de Minka Digital: **diagnóstico P0**, **onboarding**, **portal** y el
**embudo de postulación** de Carreras de Éxito (cliente Juanelo).
CRM = **Odoo** (GHL purgado 2026-07-16; ver `README.md`). Node ≥18, sin build step, sin dependencias.

## Deploy — es AUTOMÁTICO (GitHub → Vercel), reconectado 2026-07-29

Un `git push` a `main` **sí despliega solo** a producción — verificado empíricamente el
2026-07-29: el deployment `dpl_9zxrPgN2KfDj4whJ2xGTGWXQ1EuN` se creó a las 20:57:59 UTC, 9
segundos después del push del commit `b900664` (`vercel inspect` confirmó que el alias de
prod `minka-webhooks.vercel.app` apunta exactamente a ese deployment). El proyecto vive bajo
el **team `minkadigital`** en Vercel (Gerónimo lo conectó/transfirió; Project Settings → Git
muestra `geronimoglez/minka-webhooks` conectado).

**Ya no hace falta `npm run deploy` en el flujo normal** — solo si necesitas forzar un deploy
sin pasar por git (poco común):

```powershell
npm run deploy   # = npm test && vercel --prod --yes --scope minkadigital
```

`npm run deploy` corre la suite ANTES de desplegar: no se sube nada con tests en rojo.
(El `--scope` decía `geronimoglezs-projects`, el nombre viejo del team antes de renombrarse a
`minkadigital` — el deploy manual llevaba tiempo roto.)

Prod alias: <https://minka-webhooks.vercel.app>

Para verificar un deploy: `curl -s -o /dev/null -w "%{http_code}" https://minka-webhooks.vercel.app/api/onboarding` → `405` = vivo (POST-only). Para confirmar QUÉ commit está en prod: `vercel ls minka-webhooks` (lista deployments con edad) + `vercel inspect <url>` (fecha de creación, cotejar contra `git log`).

> Nota para agentes sin sesión de Vercel propia: el conector MCP de Vercel puede no ver este
> proyecto aunque exista (token de cuenta con caché desalineada del lado del conector, no un
> problema real de Vercel) — si `get_project`/`list_projects` no lo encuentra, no asumas que
> no existe. Confirmar con `vercel login` (device-auth, requiere que Gerónimo apruebe una vez
> en el navegador) + `vercel project ls` / `vercel ls minka-webhooks` antes de reportar un
> bloqueo de acceso.

## Arquitectura en 30 segundos (salidas vs webhooks)

- Los endpoints hablan con el CRM por **llamada SALIENTE**: JSON-RPC a Odoo vía
  `lib/crm.js`, autenticando con las credenciales `ODOO_*`. **No es un webhook.**
- OpenRouter (LLM del diagnóstico) y Telegram también son **salientes** (cada uno con su llave).
- **No hay webhooks ENTRANTES hoy.** (`api/ghl.js`, que recibía pushes de GHL, se borró.)
- Un endpoint nuevo que escriba al CRM (p.ej. **minka-brain**) **reusa `lib/crm.js`** —
  `require("../lib/crm")` + `pushLead(...)`. **No necesita webhook ni variables nuevas de CRM.**
- Solo harías un **webhook nuevo** si algo EXTERNO (Odoo, Minka Director, Stripe, un form) te
  **empuja** eventos. En ese caso: endpoint nuevo + secreto propio con nombre (`MINKA_DIRECTOR_WEBHOOK_SECRET`),
  **fail-closed** (rechazar si el secreto está vacío — nunca `if(!SECRET) return true`).

## Env vars (Vercel)

Vivas y necesarias: `ODOO_URL` / `ODOO_DB` / `ODOO_USER` / `ODOO_API_KEY`,
`OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
(+ opcionales `DIAGNOSTICO_MODEL`, `DIAGNOSTICO_MAIL_*`, `CRM_DRIVER`, `ODOO_WAKE_*`).
Detalle en `.env.example`.
`GHL_*` / `NOTION_*` / `OPENCLAW_*` / `WEBHOOK_SHARED_SECRET`: eliminadas (eran del webhook GHL borrado).

## Embudo de postulación (carrerasdeexito.com — cliente Juanelo)

Forma nativa **sin JavaScript** (la mayoría del tráfico llega del navegador dentro de WhatsApp).
El POST es una navegación, no un fetch → **no hay CORS que configurar**. Se expone same-origin
desde `carrerasdeexito.com` con rewrites **ruta por ruta** (nunca `/api/:path*`, que expondría
diagnóstico y onboarding). El sitio vive en el repo `geronimoglez/carreras-de-exito`.

| Ruta pública | Función | Qué hace |
|---|---|---|
| `/postulacion` | `api/postulacion.js` | GET pinta la forma · POST valida, guarda el lead, 303 a gracias |
| `/postulacion/gracias` | `api/postulacion-gracias.js` | Ofrece el apartado y la subida de documentos |
| `/postulacion/pago` | `api/postulacion-pago.js` | Crea la Checkout Session y 303 a Stripe |
| `/postulacion/pagado` | `api/postulacion-pagado.js` | Retorno de Stripe (success **y** cancel) |
| `/postulacion/documentos` | `api/postulacion-documentos.js` | Reconocimientos (multipart) |
| — (directo, no rewritten) | `api/stripe-webhook.js` | El pago que llega aunque nadie vuelva |

**El orden es la decisión de negocio:** primero se guarda el lead, **después** se cobra. Si la
persona abandona el pago, su postulación ya está en el CRM. Nunca al revés.

**Los documentos van aparte de la forma** a propósito: sin JS no se puede medir el peso de un
archivo antes de mandarlo, y Vercel corta a 4.5 MB **antes** de que corra nuestro código. Si los
archivos viajaran con la forma, una foto pesada tiraría un 413 y la persona perdería todo lo que
escribió.

**Copy — regla que no se rompe:** no hay curaduría real (se acepta a todos). El apartado se
justifica como *"son 50 lugares, apártalo"*, **nunca** como *"si no quedas seleccionado"*.
Decisión explícita de honestidad de Gerónimo.

## Dinero (Stripe) — invariantes

- La cuenta de Stripe es de **Minka**, no del cliente → el cargo aparece a nombre de Minka en el
  estado de cuenta. El aviso de privacidad **tiene que decirlo** (si no, contracargo).
- El monto sale de `EVENTO_APARTADO_MXN`, **nunca** del formulario.
- `lib/apartado.js` es el único lugar que registra un pago, y es **idempotente** (marca de dedup =
  id de la sesión de Stripe) porque el pago llega por dos caminos: el retorno del navegador y el
  webhook. Los dos hacen falta: sin webhook se pierde el pago de quien cierra la pestaña; sin
  retorno la persona ve "no pagado" unos segundos.
- **No se confía en el payload de Stripe.** De la petición se lee sólo el id de la sesión; el
  estado, el monto y el lead salen de re-consultar esa sesión con la llave secreta. El webhook
  además exige un secreto propio en la URL, fail-closed. (Por qué no se verifica la firma
  `Stripe-Signature`: el runtime Node de Vercel ya parseó el cuerpo cuando corre el handler y no
  conserva los bytes exactos; ver el comentario de cabecera de `api/stripe-webhook.js`.)

## CRM multi-tenant

`lib/crm.js` acepta un `tenant` opcional en todas sus funciones → resuelve `ODOO_*_<TENANT>`.
**Sin fallback al global**: un tenant sin credenciales degrada a "none" antes que escribir los
datos de un cliente en la base de otro. Los caches de uid y de ids de etapa van **por tenant** (los
ids de `crm.stage` son por base de datos).

## Tests (sin deps; corren con node a secas)

```powershell
node test/crm_retry.test.js          # wake-retry de Odoo + saneo de PII + escape de =ilike
node test/onboarding_cmd.test.js     # shellSafe del "comando sugerido"
node test/diagnostico_html.test.js   # render del HTML del diagnóstico
node test/diagnostico_llm.test.js    # retry+fallback de modelo, normalizeReport, rate-limit, waitUntil
node test/diagnostico_flow.test.js   # blindaje: el lead entra al CRM ANTES del LLM (FASE 1)
node test/crm_tenant.test.js        # aislamiento multi-tenant (sin fallback, caches separados)
node test/multipart.test.js         # parser multipart (incluido el binario con el delimitador dentro)
node test/postulacion.test.js       # validación, escapado, firma de archivos, apartado idempotente
```

## Blindaje anti-pérdida del diagnóstico P0 (FASE 1, 2026-07-29) — no regresar

`api/diagnostico.js` guarda el lead en el CRM **antes** de depender del LLM, y en paralelo (no en
serie) para no pagar latencia. Invariantes que los tests protegen:

- **`crm.pushLead` arranca antes de `callLLM`.** Si el LLM falla, el prospecto ya está en Odoo y
  Telegram avisa igual. Mover el push abajo del LLM es exactamente el bug que se arregló.
- El **enriquecimiento** (nota + adjunto HTML) es trabajo NO crítico: va en segundo plano con
  `waitUntil`, y usa `crm.addLeadNote` (1 RPC) en vez de repetir el `pushLead` completo (~8 RPCs).
- `waitUntil` se implementa **sin dependencias**, con el mismo `Symbol.for("@vercel/request-context")`
  que usa `@vercel/functions`. Si el runtime no lo expone, degrada a `await`. **No instalar el
  paquete**: arrastra 25 deps y obligaría a un `npm install` en el build que hoy no existe.
- `normalizeReport` garantiza que `cuellos`/`quickwins` lleguen al front **siempre como array**.

## El diagnóstico SE LE MANDA al prospecto (FASE 2, 2026-07-29) — no regresar

La página promete *"aquí te mandamos el diagnóstico"*; hasta esta fase nada lo mandaba y el reporte
sólo vivía en la pestaña del navegador. Ahora `api/diagnostico.js` lo envía por correo:

- **Sale por Odoo** (`crm.sendLeadEmail` → `mail.mail` + addon `minka_ses` → AWS SES). Es el mismo
  camino que ya usa `scripts/p0_nurture.py` en producción: **cero credenciales de correo en Vercel**,
  misma identidad verificada en SES, y queda en el **chatter del lead**. No meter aquí un SDK de
  correo ni un segundo remitente: partiría la reputación del dominio.
- **`email_from` va vacío a propósito** → Odoo usa el suyo (`noreply@minkadigital.com`). Cambiarlo
  sin verificar antes la dirección en SES tumba TODO el envío. El `reply_to` (hola@) sí es libre.
- **`send` va con `raise_exception: true`**: por default Odoo marca `state="exception"` y no lanza,
  así que un rechazo de SES sería invisible y volveríamos a prometer un correo que no sale.
- **El correo tiene su propio render** (`renderDiagnosticoEmail`), con tablas y estilos inline. El
  HTML del adjunto usa variables CSS, `@media` y flex/grid: Gmail borra lo primero y Outlook no
  entiende lo segundo. Son dos envases del mismo contenido — al tocar uno, revisar el otro.
- **Es trabajo no crítico**: va en el `waitUntil`, al final del enriquecimiento (lead y adjunto
  primero). Un fallo de correo nunca rompe la respuesta al usuario.
- **Un fallo de correo avisa por Telegram**, no sólo por `console.error`. Los logs de Vercel no los
  mira nadie — por eso este hueco duró meses. No quitar ese aviso.
- **La respuesta 200 lleva `mail: <bool>`** (síncrono: driver odoo + kill-switch encendido). El
  sitio sólo dice "también te lo mandamos a tu correo" cuando viene `true`. Si algún día el envío
  se apaga, la pantalla deja de prometerlo sola.
- **NO se dedupea el envío.** Colgarlo del `deduped` de `attachToLead` parecía gratis pero abría un
  fallo silencioso: si el primer correo falló, el segundo intento se saltaba y el prospecto se
  quedaba sin nada. Cada diagnóstico nuevo se entrega; el techo contra abuso es el rate-limit.

## Privacidad / seguridad (no regresar)

- **Nunca** reflejar al cliente el `detail` crudo de un error de CRM/Odoo (puede eco-ar PII).
  `lib/crm.js` sanea en origen (`odoo-rejected:<Clase>`); `api/onboarding.js` tiene allowlist `safeDetail`.
- Emails a `=ilike` de Odoo van **escapados** (`escLike`) — sin eso, `%@%` casa un contacto arbitrario.
- Valores de usuario en el "comando sugerido" de Telegram van por `shellSafe` (anti copy-paste injection).
