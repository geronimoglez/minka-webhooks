# minka-webhooks

Endpoint receptor para eventos de GoHighLevel (stage changes, tag added, contact created, etc.). Vive en Vercel, decoupled del landing y de openclaw.

## Arquitectura

```
┌─────────────┐    workflow action "Webhook"    ┌──────────────────┐
│ GHL Workflow│ ────────────────────────────────>│ Vercel function  │
│ (Sedeco 2026│         POST application/json   │ /api/ghl         │
└─────────────┘                                  └──────────────────┘
                                                          │
                                  ┌───────────────────────┼───────────────────────┐
                                  v                       v                       v
                          ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
                          │ Notion log   │       │ Telegram bot │       │ openclaw     │
                          │ (audit row)  │       │ (Geronimo)   │       │ /sedeco-trigger
                          └──────────────┘       └──────────────┘       └──────────────┘
```

**Por qué Vercel y no inyectar a openclaw:**
- Zero riesgo de romper el deploy actual de openclaw en Railway
- Logs nativos de Vercel para debugging
- Cold start ~50ms, gratis hasta 100k invocaciones/mes
- Si openclaw cambia, el webhook sigue funcionando

**Por qué un solo endpoint multifunción:**
- Una sola URL para pegar en GHL workflows
- El handler ramifica internamente según el `event_type` del payload

## Endpoints

### POST `/api/ghl`
Recibe eventos genéricos de workflows de GHL.

**Headers que pega GHL automáticamente:**
- `X-Webhook-Signature` — HMAC del body con shared secret (opcional)

**Body esperado** (definido por ti en el workflow GHL → "Add Webhook" action):
```json
{
  "event": "stage_changed",
  "contact_id": "{{contact.id}}",
  "contact_name": "{{contact.first_name}} {{contact.last_name}}",
  "email": "{{contact.email}}",
  "stage_name": "{{opportunity.pipeline_stage}}",
  "rubro": "{{contact.sedeco_rubro}}",
  "monto": "{{contact.sedeco_monto_máximo_mxn}}"
}
```

**Response:**
```json
{ "ok": true, "received": "stage_changed", "fanout": ["notion", "telegram"] }
```

### GET `/api/ghl`
Health check. Útil para validar que Vercel está vivo cuando GHL te dice "webhook failed".

## Variables de entorno (set en Vercel)

| Var | Required | Para qué |
|---|---|---|
| `WEBHOOK_SHARED_SECRET` | recomendado | Validar `X-Webhook-Signature` |
| `NOTION_TOKEN` | opcional | Loggear cada evento a una database Notion |
| `NOTION_DATABASE_ID` | opcional | DB destino del log |
| `TELEGRAM_BOT_TOKEN` | opcional | Mandar notificación al chat de Gero |
| `TELEGRAM_CHAT_ID` | opcional | ID de chat destino |
| `OPENCLAW_WEBHOOK_URL` | opcional | Forward el evento a openclaw |
| `OPENCLAW_GATEWAY_TOKEN` | opcional | Auth contra openclaw |

Cualquier integración cuya env var falte se salta silenciosamente (con log).

## Deploy

```powershell
cd C:\Users\gglez\Docs\Claude\Projects\MinkaDigital\minka-webhooks
npm install
vercel --prod --yes --scope geronimoglezs-projects
```

Te devuelve una URL tipo `https://minka-webhooks-xxx.vercel.app/api/ghl`. Esa es la que pegas en el workflow GHL.

(Opcional) custom domain: `webhooks.minkadigital.com`.

## Configurar en GHL

En el Workflow AI Builder, cuando arme el workflow W5 ("Implementación arranca"), pídele que añada una acción "Webhook":
- Method: POST
- URL: `https://webhooks.minkadigital.com/api/ghl` (o la URL que Vercel te dé)
- Headers: `Content-Type: application/json`
- Body: el JSON template de arriba

Si AI Builder no tiene acción "Webhook" nativa, GHL la tiene como acción manual de Workflow llamada "Webhooks" o "Send Webhook". Selecciónala manualmente.

## Probar local

```powershell
npm run dev
# en otra terminal:
curl -X POST http://localhost:3000/api/ghl `
  -H "Content-Type: application/json" `
  -d '{"event":"test","contact_name":"Geronimo Test"}'
```

## Forwarding patterns

El handler ramifica según el event. Personaliza en `api/ghl.js`:

| event | Acción |
|---|---|
| `stage_changed` | Log a Notion + notify Telegram |
| `implementacion_arranca` | Forward a openclaw para crear subagente |
| `deal_lost` | Telegram alert |
| `*` (cualquier otro) | Solo log |
