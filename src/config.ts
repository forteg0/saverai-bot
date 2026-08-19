import "dotenv/config"

/**
 * Configuracion del bot de WhatsApp.
 *
 * El bot es SOLO un canal: transcribe, normaliza, pregunta lo que falta y le
 * manda el gasto ya confirmado al backend, que decide si se publica o no.
 * No toca la base de datos.
 */

export interface AiConfig {
  provider: string
  baseUrl: string
  apiKey: string
  whisperModel: string
  chatModel: string
}

export interface BotConfig {
  port: number
  graphVersion: string
  verifyToken: string
  accessToken: string
  phoneNumberId: string
  appSecret?: string
  /** URL del backend de CapsaAI (server/). */
  backendUrl: string
  /** Mismo secreto que WHATSAPP_WEBHOOK_SECRET del backend: firma el payload. */
  webhookSecret: string
  /** null si no hay clave de IA: el bot sigue andando, pero sin transcribir audios. */
  ai: AiConfig | null
  /** true = logs detallados paso a paso (BOT_DEBUG=1). Por defecto, logs limpios. */
  debug: boolean
}

const AI_PRESETS: Record<string, { baseUrl: string; keyEnv: string; whisper: string; chat: string }> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    whisper: "whisper-large-v3-turbo",
    // Los Llama estandar dejaron de estar disponibles en el tier gratis; gpt-oss-20b es estable.
    chat: "openai/gpt-oss-20b",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    keyEnv: "OPENAI_API_KEY",
    whisper: "whisper-1",
    chat: "gpt-4o-mini",
  },
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Falta la variable de entorno ${name}`)
  return value
}

function resolveAi(): AiConfig | null {
  const provider = (process.env.AI_PROVIDER || "groq").toLowerCase()

  if (provider === "custom") {
    const baseUrl = process.env.AI_BASE_URL
    if (!baseUrl) return null
    return {
      provider,
      baseUrl: baseUrl.replace(/\/$/, ""),
      apiKey: process.env.AI_API_KEY || "",
      whisperModel: process.env.WHISPER_MODEL || "whisper-large-v3",
      chatModel: process.env.EXPENSE_PARSER_MODEL || "llama-3.3-70b-versatile",
    }
  }

  const preset = AI_PRESETS[provider]
  if (!preset) return null

  const apiKey = process.env[preset.keyEnv]
  if (!apiKey) return null

  return {
    provider,
    baseUrl: preset.baseUrl,
    apiKey,
    whisperModel: process.env.WHISPER_MODEL || preset.whisper,
    chatModel: process.env.EXPENSE_PARSER_MODEL || preset.chat,
  }
}

export function getBotConfig(): BotConfig {
  const port = Number(process.env.BOT_PORT ?? 4020)
  if (!Number.isInteger(port) || port <= 0) throw new Error("BOT_PORT debe ser un entero positivo")

  return {
    port,
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "v21.0",
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    appSecret: process.env.WHATSAPP_APP_SECRET || undefined,
    backendUrl: (process.env.BACKEND_URL || "http://localhost:4010").replace(/\/$/, ""),
    webhookSecret: required("WHATSAPP_WEBHOOK_SECRET"),
    ai: resolveAi(),
    debug: /^(1|true|yes|on)$/i.test(process.env.BOT_DEBUG ?? ""),
  }
}
