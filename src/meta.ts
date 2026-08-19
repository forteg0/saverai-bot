import { createHmac, timingSafeEqual } from "crypto"
import { BotConfig } from "./config"

/**
 * Cliente minimo de la WhatsApp Cloud API (Meta Graph API):
 * verificacion del webhook, validacion de firma, descarga de audios y envio
 * de mensajes de texto.
 */

/**
 * Canonicaliza el "9" movil de Argentina.
 *
 * WhatsApp entrega los moviles AR sin el 9 (5435...), pero la app y el backend
 * usan el formato E.164 con 9 (54935...). Para que el bot encuentre al usuario
 * en la base (y coincida con lo que crea `bot:vincular`), se agrega el 9 al
 * armar el identificador. Para ENVIAR se usa el numero tal cual lo entrego Meta
 * (asi coincide con la lista de destinatarios permitidos).
 */
export function canonicalArgentinaDigits(digits: string): string {
  if (digits.startsWith("54") && !digits.startsWith("549")) {
    return `549${digits.slice(2)}`
  }
  return digits
}

/** Identificador del usuario en el backend: "whatsapp:+549..." (con 9 en AR). */
export function toWhatsappUserId(rawPhone: string): string {
  const digits = canonicalArgentinaDigits(rawPhone.replace(/[^\d]/g, ""))
  return `whatsapp:+${digits}`
}

/**
 * Numero al que se responde por WhatsApp.
 *
 * Argentina: WhatsApp enruta los moviles SIN el 9 (54 + area + numero), aunque
 * el mensaje entrante venga con el 9. Ademas la lista de destinatarios de prueba
 * de Meta guarda el numero sin el 9. Por eso, para ENVIAR, se quita el 9; si no,
 * Meta rechaza con "(#131030) Recipient phone number not in allowed list".
 */
export function toPhoneE164(rawPhone: string): string {
  const digits = rawPhone.replace(/[^\d]/g, "")
  if (digits.startsWith("549")) return `+54${digits.slice(3)}`
  return `+${digits}`
}

/** Handshake GET que Meta hace al configurar el webhook. */
export function verifyChallenge(params: URLSearchParams, config: BotConfig): string | null {
  const mode = params.get("hub.mode")
  const token = params.get("hub.verify_token")
  if (mode === "subscribe" && token && token === config.verifyToken) {
    return params.get("hub.challenge") ?? ""
  }
  return null
}

/** Valida X-Hub-Signature-256. Si no hay APP_SECRET configurado, se omite. */
export function isValidMetaSignature(rawBody: Buffer, signature: string | undefined, config: BotConfig): boolean {
  if (!config.appSecret) return true
  if (!signature) return false

  const expected = "sha256=" + createHmac("sha256", config.appSecret).update(rawBody).digest("hex")
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface DownloadedMedia {
  buffer: Buffer
  mimeType: string
}

/** Descarga un audio en dos pasos, como exige la Graph API. */
export async function downloadMedia(mediaId: string, config: BotConfig): Promise<DownloadedMedia> {
  const base = `https://graph.facebook.com/${config.graphVersion}`

  const metaResponse = await fetch(`${base}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!metaResponse.ok) {
    throw new Error(`No se pudo resolver el media ${mediaId}: ${metaResponse.status}`)
  }

  const media = (await metaResponse.json()) as { url?: string; mime_type?: string }
  if (!media.url) throw new Error(`El media ${mediaId} no trajo url`)

  const fileResponse = await fetch(media.url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  })
  if (!fileResponse.ok) throw new Error(`No se pudo descargar el media ${mediaId}: ${fileResponse.status}`)

  return {
    buffer: Buffer.from(await fileResponse.arrayBuffer()),
    mimeType: media.mime_type || "audio/ogg",
  }
}

export async function sendText(toPhone: string, body: string, config: BotConfig): Promise<void> {
  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toPhone.replace(/^\+/, ""),
      type: "text",
      text: { preview_url: false, body },
    }),
  })

  if (!response.ok) {
    console.error("WhatsApp sendText fallo:", response.status, await response.text())
  }
}
