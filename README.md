# minka-webhooks

Endpoints serverless de Minka Digital en Vercel: capturan leads del sitio (diagnóstico P0,
onboarding), consultan el estado del cliente en el portal, y persisten al CRM (Odoo) con aviso
a Telegram. Desacoplados del landing.

> **GHL purgado (2026-07-16, decisión Gerónimo).** Se salió de GoHighLevel. Se eliminaron el
> webhook `/api/ghl`, el endpoint de pre-calificación SEDECO (`/api/precalifica`, campaña
> cancelada) y el driver `ghl` del adaptador CRM. El CRM es **Odoo**. Ver la sección
> _Migración_ abajo para el checklist de secretos en Vercel/GHL.

## Endpoints

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/api/diagnostico` | Diagnóstico P0 (lead-magnet): form → LLM (OpenRouter) → lead + reporte HTML a Odoo → Telegram |
| POST | `/api/onboarding` | Activación de plan: captura el "paquete de conocimiento" → lead/opportunity en Odoo → ping accionable a Telegram |
| POST | `/api/portal-status` | Portal del cliente: consulta estado por email + últimos 4 dígitos de WhatsApp (anti-enumeración) |

Todos responden `GET`/`OPTIONS` de forma segura (CORS restringido a `minkadigital.com`) y
**nunca reflejan datos crudos del CRM ni de errores internos** en la respuesta pública
(ver `lib/crm.js` y el allowlist `safeDetail` en `api/onboarding.js`).

## CRM (Odoo) — `lib/crm.js`

Un solo contrato para todos los endpoints; el backend se elige por env:

- `CRM_DRIVER = "odoo" | "none"` (default: auto → `odoo` si hay `ODOO_URL`+`ODOO_DB`+`ODOO_API_KEY`, si no `none`).
- Driver `none` = degradación honesta: el endpoint sigue respondiendo y el lead viaja completo por Telegram; responde `crm:"skipped"`. Nada se rompe si Odoo está caído o sin configurar.
- Odoo se habla por JSON-RPC estándar (`/jsonrpc`, `object.execute_kw`): `res.partner` + `crm.lead` + chatter.

## Variables de entorno (set en Vercel)

| Var | Required | Para qué |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | recomendado | Avisos al chat de Gerónimo |
| `TELEGRAM_CHAT_ID` | recomendado | Chat destino |
| `OPENROUTER_API_KEY` | sí (diagnóstico) | LLM del diagnóstico P0 |
| `DIAGNOSTICO_MODEL` | opcional | Override del modelo (default en código) |
| `ODOO_URL` / `ODOO_DB` / `ODOO_USER` / `ODOO_API_KEY` | sí (para persistir) | Conexión Odoo JSON-RPC |
| `CRM_DRIVER` | opcional | Fuerza `odoo` o `none` |
| `ODOO_WAKE_RETRIES` / `ODOO_WAKE_BACKOFF_MS` / `ODOO_WAKE_MAX_MS` | opcional | Wake-retry del cold-start de Railway |

Cualquier integración cuya env var falte se salta silenciosamente (con log). Ver `.env.example`.

## Deploy

```powershell
cd C:\Users\gglez\Docs\Claude\Projects\MinkaDigital\minka-webhooks
npm install
vercel --prod --yes --scope geronimoglezs-projects
```

Custom domain: `webhooks.minkadigital.com`.

## Probar local

```powershell
npm run dev
# en otra terminal:
curl -X POST http://localhost:3000/api/onboarding `
  -H "Content-Type: application/json" `
  -d '{"plan":"respuesta-ia","nombre":"Test","email":"t@x.com","whatsapp":"3312345678","negocio":"Demo"}'
```

## Tests

```powershell
node test/crm_retry.test.js         # wake-retry + saneo de PII en el detail de Odoo
node test/diagnostico_html.test.js  # render del HTML del diagnóstico
```

## Migración desde GHL — checklist de secretos (hacer en los dashboards)

El código ya no usa GHL, pero los secretos siguen vivos en los proveedores hasta que se borren a mano:

1. **Vercel → Project → Settings → Environment Variables:** borrar `GHL_TOKEN_LOCATION`,
   `GHL_LOCATION_ID`, `GHL_PIPELINE_ID`, `GHL_STAGE_1_ID`, `GHL_STAGE_2_ID`, y (ya sin uso)
   `WEBHOOK_SHARED_SECRET`, `NOTION_TOKEN`, `NOTION_DATABASE_ID`, `OPENCLAW_WEBHOOK_URL`,
   `OPENCLAW_GATEWAY_TOKEN`.
2. **GoHighLevel:** revocar/rotar el PIT token (`GHL_TOKEN_LOCATION`) — daba acceso a la
   cuenta con los leads. Desactivar cualquier workflow que apuntara a `/api/ghl`.
