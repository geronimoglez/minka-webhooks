# CLAUDE.md — minka-webhooks

Endpoints serverless (Vercel) de Minka Digital: **diagnóstico P0**, **onboarding**, **portal** y el
**embudo de postulación** de Carreras de Éxito (cliente Juanelo).
CRM = **Odoo** (GHL purgado 2026-07-16; ver `README.md`). Node ≥18, sin build step, sin dependencias.

## ⚠️ Deploy — es MANUAL (no hay auto-deploy)

Este proyecto **NO tiene conectado el auto-deploy de GitHub → Vercel**. Un `git push` a
`main` **NO despliega nada** a producción. El deploy es manual, con la CLI de Vercel:

```powershell
npm run deploy   # = npm test && vercel --prod --yes --scope minkadigital
```

`npm run deploy` corre la suite ANTES de desplegar: no se sube nada con tests en rojo.
(El `--scope` decía `geronimoglezs-projects`, el nombre viejo del team antes de renombrarse a
`minkadigital` — el deploy manual llevaba tiempo roto.)

Prod alias: <https://minka-webhooks.vercel.app>

> Contexto: el auto-deploy GitHub→Vercel se complicó una vez y se dejó desconectado a
> propósito. Como este repo es de un solo proyecto, se podría reconectar directo si algún
> día se quiere (pendiente, no urgente). Mientras tanto: **siempre `npm run deploy`**.

Para verificar un deploy: `curl -s -o /dev/null -w "%{http_code}" https://minka-webhooks.vercel.app/api/onboarding` → `405` = vivo (POST-only).

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
(+ opcionales `DIAGNOSTICO_MODEL`, `CRM_DRIVER`, `ODOO_WAKE_*`). Detalle en `.env.example`.
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
node test/crm_retry.test.js         # wake-retry de Odoo + saneo de PII + escape de =ilike
node test/crm_tenant.test.js        # aislamiento multi-tenant (sin fallback, caches separados)
node test/multipart.test.js         # parser multipart (incluido el binario con el delimitador dentro)
node test/postulacion.test.js       # validación, escapado, firma de archivos, apartado idempotente
node test/onboarding_cmd.test.js    # shellSafe del "comando sugerido"
node test/diagnostico_html.test.js  # render del HTML del diagnóstico
```

## Privacidad / seguridad (no regresar)

- **Nunca** reflejar al cliente el `detail` crudo de un error de CRM/Odoo (puede eco-ar PII).
  `lib/crm.js` sanea en origen (`odoo-rejected:<Clase>`); `api/onboarding.js` tiene allowlist `safeDetail`.
- Emails a `=ilike` de Odoo van **escapados** (`escLike`) — sin eso, `%@%` casa un contacto arbitrario.
- Valores de usuario en el "comando sugerido" de Telegram van por `shellSafe` (anti copy-paste injection).
