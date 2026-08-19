import { createHmac } from "crypto"
import { BotConfig } from "./config"

/**
 * Cliente del backend de CapsaAI.
 *
 * El bot NO escribe en la base: le manda el gasto ya confirmado por el usuario
 * al endpoint del backend, firmado con HMAC, y el backend decide si lo publica
 * (201), si ya existia (200) o si sus reglas lo rechazan (422).
 */

export interface ConfirmedExpensePayload {
  userId: string
  messageId: string
  sourceMessageIds: string[]
  confirmedAt: string
  expense: {
    amount: number
    merchant: string
    category: string
    card: string
    date: string
    description?: string
  }
}

export interface BackendResponse {
  httpStatus: number
  status: string
  errors?: Array<{ field: string; code: string; detail: string }>
  raw: unknown
}

export async function publishConfirmedExpense(
  payload: ConfirmedExpensePayload,
  config: BotConfig,
): Promise<BackendResponse> {
  const body = JSON.stringify(payload)
  const signature = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex")

  const response = await fetch(`${config.backendUrl}/webhooks/whatsapp/expenses/confirmed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-capsa-signature": signature,
    },
    body,
  })

  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }

  const asRecord = (parsed ?? {}) as Record<string, unknown>
  return {
    httpStatus: response.status,
    status: typeof asRecord.status === "string" ? asRecord.status : String(response.status),
    errors: Array.isArray(asRecord.errors) ? (asRecord.errors as BackendResponse["errors"]) : undefined,
    raw: parsed,
  }
}
