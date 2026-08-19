import { createServer, IncomingMessage } from "http"
import { getBotConfig } from "./config"
import {
  downloadMedia,
  isValidMetaSignature,
  sendText,
  toPhoneE164,
  toWhatsappUserId,
  verifyChallenge,
} from "./meta"
import { transcribeAudio } from "./transcribe"
import { describeExpense, handleIncomingMessage } from "./session"
import { getBotContext } from "./context"
import { publishConfirmedExpense } from "./backend"
import { debug, error as logError, info, setDebug, warn } from "./log"

/**
 * Bot de WhatsApp de CapsaAI.
 *
 * Es el canal de entrada, no la autoridad: recibe el audio, lo transcribe,
 * completa el gasto conversando con el usuario y, una vez confirmado, se lo
 * manda firmado al backend, que decide si se publica.
 *
 *   GET  /webhooks/whatsapp/inbound  -> verificacion de Meta
 *   POST /webhooks/whatsapp/inbound  -> mensajes entrantes
 *   GET  /health
 */

const config = getBotConfig()
setDebug(config.debug)

const INBOUND_PATH = "/webhooks/whatsapp/inbound"

/**
 * Anti-reproceso en memoria. Meta reintenta si tardamos en responder 200, y
 * puede reenviar el mismo mensaje. La idempotencia REAL la garantiza el backend
 * (`external_message_id UNIQUE`); esto solo evita trabajo duplicado dentro del
 * proceso. Acotado en tamano para no crecer sin limite en corridas largas.
 */
const SEEN_CAP = 1000
const seenMessageIds = new Set<string>()

function alreadySeen(id: string): boolean {
  if (seenMessageIds.has(id)) return true
  seenMessageIds.add(id)
  if (seenMessageIds.size > SEEN_CAP) {
    const oldest = seenMessageIds.values().next().value
    if (oldest !== undefined) seenMessageIds.delete(oldest)
  }
  return false
}

/**
 * Cola de procesamiento POR USUARIO.
 *
 * Los mensajes de un mismo usuario se procesan de a uno y en orden. Sin esto,
 * mandar varios audios/textos seguidos hace que se procesen en paralelo y se
 * pisen el estado de la conversacion (p. ej. un audio nuevo "consume" la
 * pregunta de la tarjeta del audio anterior). Usuarios distintos siguen en
 * paralelo entre si.
 */
const userQueues = new Map<string, Promise<void>>()

function enqueueMessage(message: WhatsAppMessage): void {
  const userId = toWhatsappUserId(message.from)
  const prev = userQueues.get(userId) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(() => handleMessage(message))
    .catch((err) => logError("Error no controlado procesando mensaje", err))
  userQueues.set(userId, next)
  void next.then(() => {
    if (userQueues.get(userId) === next) userQueues.delete(userId)
  })
}

interface WhatsAppMessage {
  id: string
  from: string
  type: string
  text?: { body?: string }
  audio?: { id?: string; mime_type?: string }
}

function readRawBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    request.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > 1024 * 1024) {
        reject(new Error("Cuerpo demasiado grande"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })
}

function collectMessages(payload: unknown): WhatsAppMessage[] {
  const messages: WhatsAppMessage[] = []
  const root = payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: WhatsAppMessage[] } }> }> }

  for (const entry of root?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value?.messages ?? []) {
        messages.push(message)
      }
    }
  }

  return messages
}

/** Error de negocio con un mensaje ya listo para responderle al usuario. */
class UserFacingError extends Error {}

/** Convierte el mensaje de WhatsApp en texto (transcribiendo si es audio). */
async function resolveText(message: WhatsAppMessage): Promise<string | null> {
  if (message.type === "text" && message.text?.body) {
    return message.text.body.trim() || null
  }

  if (message.type === "audio" && message.audio?.id) {
    if (!config.ai) {
      throw new UserFacingError(
        "Recibí un audio pero no tengo configurada la transcripción. Escribime el gasto por texto por ahora.",
      )
    }
    let media
    try {
      media = await downloadMedia(message.audio.id, config)
    } catch (err) {
      logError("No pude descargar el audio de Meta", err)
      throw new UserFacingError("No pude bajar el audio (¿token de WhatsApp vencido?). Probá de nuevo o mandámelo por texto.")
    }
    try {
      const text = await transcribeAudio(media.buffer, media.mimeType, config.ai)
      debug(`audio transcripto: "${text}"`)
      return text
    } catch (err) {
      logError("Falló la transcripción", err)
      throw new UserFacingError("No pude entender el audio. Probá hablar más claro, o escribime el gasto por texto.")
    }
  }

  // Otros tipos (imagen, sticker, ubicacion, etc.)
  return null
}

function describeBackendResult(
  result: Awaited<ReturnType<typeof publishConfirmedExpense>>,
  detail: string,
): string {
  if (result.status === "created") {
    return `✅ Registré ${detail}.`
  }
  if (result.status === "duplicate") {
    return "Ese gasto ya estaba cargado, no lo dupliqué 👍"
  }
  if (result.status === "invalid") {
    const detail = result.errors?.map((item) => `• ${item.detail}`).join("\n")
    return `El backend rechazó el gasto:\n${detail ?? "no cumple las reglas."}`
  }
  if (result.httpStatus === 401) {
    return "No pude autenticarme con el backend. Avisale al equipo (firma invalida)."
  }
  return "Hubo un problema al guardarlo. Probá de nuevo en un rato."
}

async function handleMessage(message: WhatsAppMessage): Promise<void> {
  const phone = toPhoneE164(message.from)
  const userId = toWhatsappUserId(message.from)

  // 1) Obtener el texto (transcribiendo si es audio).
  let text: string | null
  try {
    text = await resolveText(message)
  } catch (err) {
    if (err instanceof UserFacingError) {
      await sendText(phone, err.message, config)
      return
    }
    logError("Error leyendo el mensaje", err)
    await sendText(phone, "Se me complicó procesar tu mensaje. Probá de nuevo en un rato 🙏", config)
    return
  }

  if (!text) {
    await sendText(
      phone,
      'Mandame un audio o un texto con el gasto, por ejemplo: "gasté 2000 en comida en Tepanyaki".',
      config,
    )
    return
  }

  debug(`${message.type} de ${message.from} → "${text}"`)

  // 2) Conversar: completar el gasto y decidir si se publica.
  const context = await getBotContext(userId, config.backendUrl)
  const outcome = await handleIncomingMessage({ userId, messageId: message.id, text }, config.ai, context)

  if (!outcome.confirmed) {
    debug(`respuesta: "${outcome.reply}"`)
    await sendText(phone, outcome.reply, config)
    return
  }

  // 3) Publicar en el backend.
  const detail = describeExpense(outcome.confirmed.expense)
  try {
    const result = await publishConfirmedExpense(outcome.confirmed, config)
    if (result.status === "created") info(`✔ ${detail} — ${userId}`)
    else if (result.status === "duplicate") info(`= duplicado: ${detail} — ${userId}`)
    else warn(`backend rechazó (${result.httpStatus}/${result.status}): ${detail}`)
    await sendText(phone, describeBackendResult(result, detail), config)
  } catch (err) {
    logError("No pude publicar en el backend", err)
    await sendText(
      phone,
      "Entendí tu gasto pero no pude guardarlo (el servidor no responde). Ya vuelvo a intentar más tarde 🙏",
      config,
    )
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://localhost:${config.port}`)
    debug(`${request.method} ${url.pathname}`)

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ status: "ok", backend: config.backendUrl, ia: config.ai?.provider ?? null }))
      return
    }

    if (request.method === "GET" && url.pathname === INBOUND_PATH) {
      const challenge = verifyChallenge(url.searchParams, config)
      if (challenge === null) {
        warn("verificación de webhook rechazada (verify_token no coincide)")
        response.writeHead(403).end("Forbidden")
        return
      }
      info("webhook verificado por Meta ✓")
      response.writeHead(200, { "content-type": "text/plain" }).end(challenge)
      return
    }

    if (request.method === "POST" && url.pathname === INBOUND_PATH) {
      const rawBody = await readRawBody(request)

      if (!isValidMetaSignature(rawBody, request.headers["x-hub-signature-256"] as string | undefined, config)) {
        warn("firma de Meta inválida (x-hub-signature-256)")
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ status: "unauthorized" }))
        return
      }

      // Se responde 200 enseguida: Meta reintenta si tardamos mas de unos segundos.
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }))

      let payload: unknown
      try {
        payload = JSON.parse(rawBody.toString("utf8"))
      } catch {
        debug("cuerpo no era JSON válido, ignorado")
        return
      }

      const incoming = collectMessages(payload)
      if (incoming.length > 0) debug(`${incoming.length} mensaje(s) en el payload`)
      for (const message of incoming) {
        if (alreadySeen(message.id)) {
          debug(`mensaje ${message.id} ya procesado, salteado`)
          continue
        }
        enqueueMessage(message)
      }
      return
    }

    debug(`404 ${request.method} ${url.pathname}`)
    response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_found" }))
  } catch (err) {
    logError("Error en el servidor", err)
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ status: "error" }))
    }
  }
})

server.listen(config.port, () => {
  info(`Bot escuchando en http://localhost:${config.port}${INBOUND_PATH}`)
  info(`backend: ${config.backendUrl}  ·  IA: ${config.ai ? `${config.ai.provider} (${config.ai.whisperModel})` : "sin configurar"}`)
  if (config.debug) info("modo DEBUG activo (BOT_DEBUG) — logs detallados")
  if (!config.ai) warn("sin IA configurada: no se van a poder transcribir audios (falta GROQ_API_KEY)")
})
