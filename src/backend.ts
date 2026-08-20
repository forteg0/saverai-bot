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

export interface DeleteExpenseResult {
  httpStatus: number
  /** "deleted" | "not_found" | "unauthorized" | ... */
  status: string
  raw: unknown
}

/**
 * Le pide al backend que BORRE un gasto ya cargado (rollback).
 *
 * El bot no toca la base: manda el `externalMessageId` firmado con la misma
 * HMAC que los confirmados y el backend elimina la fila. Respuestas: `200`
 * borrado · `404` no existia · `401` firma invalida.
 */
export async function deleteConfirmedExpense(
  userId: string,
  externalMessageId: string,
  config: BotConfig,
): Promise<DeleteExpenseResult> {
  const body = JSON.stringify({ userId, externalMessageId })
  const signature = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex")

  const response = await fetch(`${config.backendUrl}/webhooks/whatsapp/expenses/deleted`, {
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
    raw: parsed,
  }
}

export interface ConfirmCodeResult {
  httpStatus: number
  /** "verified" | "invalid" | "expired" | "unauthorized" | ... */
  status: string
  raw: unknown
}

/**
 * Confirma un código de verificación: le dice al backend "el número `phone`
 * (el remitente real del WhatsApp) mandó el código `code`". El backend cruza
 * contra el pedido que hizo la app y marca el número como verificado.
 */
export async function confirmVerificationCode(
  phone: string,
  code: string,
  config: BotConfig,
): Promise<ConfirmCodeResult> {
  const body = JSON.stringify({ phone, code })
  const signature = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex")

  const response = await fetch(`${config.backendUrl}/auth/whatsapp/confirm`, {
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
    raw: parsed,
  }
}
