# saverai-bot

Microservicio que carga gastos por **WhatsApp** (audio o texto) para CapsaAI / SaverAI.

Es un **canal**, no la autoridad: recibe el mensaje, lo transcribe, arma el gasto
conversando con el usuario y, cuando está completo, se lo manda **firmado al
backend por HTTP**. El backend decide si lo publica. **El bot no toca la base de
datos en runtime** (la única excepción es un script de ops, ver más abajo).

```
audio/texto de WhatsApp
   → transcribe (Whisper)
   → extrae monto / categoría / comercio (reglas + LLM)
   → pregunta lo que falte (incluida la tarjeta si hay varias)
   → POST firmado /webhooks/whatsapp/expenses/confirmed
   → el backend valida sus reglas y publica (o rechaza)
```

## Estructura

```
src/
  server.ts      webhook de Meta (GET verificación / POST mensajes), puerto 4020
  meta.ts        Graph API: firma, descarga de audio, envío de texto, normalización del 9 AR
  transcribe.ts  Whisper (Groq / OpenAI / custom)
  extract.ts     LLM para sacar los campos de un solo mensaje
  session.ts     conversación (slot-filling, cola por usuario)
  normalizer.ts  normalizador por reglas — VENDORIZADO de CapsaAI (mantener en sync)
  types.ts       tipos VENDORIZADOS de CapsaAI (mantener en sync)
  context.ts     catálogo fijo de categorías/tarjetas (debe coincidir con el backend)
  backend.ts     cliente HTTP del backend (POST firmado)
  config.ts      configuración por env
  log.ts         logging (limpio por defecto, detallado con BOT_DEBUG=1)
scripts/
  link-user.ts   ops: da de alta un usuario y sus tarjetas en la BD (ÚNICO que toca la base)
  probar-audio.ts prueba transcripción + extracción sin Meta
```

## Contrato con el backend

`POST {BACKEND_URL}/webhooks/whatsapp/expenses/confirmed`, firmado con
HMAC-SHA256 del body en el header `x-capsa-signature` (secreto
`WHATSAPP_WEBHOOK_SECRET`, compartido con el backend). Respuestas: `201` creado ·
`200` duplicado · `422` inválido · `401` firma inválida.

## Puesta en marcha

```bash
npm install
cp .env.example .env      # completar credenciales
npm run link-user -- +5493511234567   # (ops) alta del usuario en la BD, una vez
npm run dev               # bot en :4020
```

Exponer con un túnel HTTPS (ngrok con dominio fijo recomendado) y configurar el
webhook de Meta a `https://TU-TUNEL/webhooks/whatsapp/inbound`, suscribiendo el
campo `messages`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Levanta el bot. |
| `npm run typecheck` | Chequeo de tipos. |
| `npm run audio -- <archivo.ogg>` | Prueba la transcripción + extracción sin Meta. |
| `npm run audio -- --texto "gaste 5000 en comida en tepanyaki"` | Ídem con texto. |
| `npm run link-user -- +549XXXXXXXXXX` | (ops) alta de usuario y tarjetas en la BD. |

## Variables de entorno

Ver `.env.example`. Runtime necesita: `WHATSAPP_*`, `BACKEND_URL`,
`WHATSAPP_WEBHOOK_SECRET`, y las de IA (`AI_PROVIDER` + su key). `DATABASE_URL`
**solo** la usa `scripts/link-user.ts`.

## Notas / límites

- **Vendorizado:** `normalizer.ts` y `types.ts` son copias del proyecto CapsaAI.
  Si el backend cambia esos contratos, hay que actualizarlos a mano.
- **Catálogo fijo:** `context.ts` tiene categorías y tarjetas hardcodeadas que
  deben coincidir con lo que valida el backend (`expense_categories` y las
  `payment_methods` que crea `link-user`).
- **Estado en memoria:** anti-duplicados y conversaciones viven en memoria (con
  expiración). Para varias instancias iría Redis o una tabla.
- **`link-user` es el único punto que toca la BD.** Idealmente eso sería un
  endpoint del backend; hoy es un script de ops para la demo.
