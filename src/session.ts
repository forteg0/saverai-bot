import { CreateTransactionInput, toLocalISODate } from "./types"
import { normalizeExpenseMessage } from "./normalizer"
import { AiConfig } from "./config"
import { BotContext, describeCards, describeCategories } from "./context"
import { guessExpenseWithLlm } from "./extract"
import { ConfirmedExpensePayload } from "./backend"

/**
 * Conversacion del bot.
 *
 * Al usuario se le piden monto, categoria y comercio:
 *   "pague 5000 en comida en Tepanyaki"
 *
 * La TARJETA se pregunta solo si el usuario tiene 2 o mas (y no fijó
 * BOT_DEFAULT_CARD); con una sola o ninguna, no se pregunta y el flujo sigue.
 * Si el usuario ya la menciono en el mensaje ("con la visa"), tampoco se pregunta.
 *
 * La FECHA nunca se pregunta: el dia de hoy, o la que se mencione ("ayer").
 *
 * Tarjeta y fecha se completan igual porque el backend las exige
 * (`payment_method_id` es obligatorio en la tabla `expenses`):
 *  - fecha  -> hoy o la mencionada,
 *  - tarjeta-> BOT_DEFAULT_CARD, o la unica del usuario (si tiene una sola).
 *
 * Orden de resolucion de cada mensaje:
 *  1. normalizador por reglas del backend (`normalizer.ts`),
 *  2. ayuda opcional de IA para los campos que quedaron vacios,
 *  3. si sigue faltando alguno de los tres, se pregunta ese campo puntual,
 *  4. completo -> se publica en el backend, que decide si lo acepta.
 *
 * El estado vive en memoria: alcanza para el prototipo, pero con varias
 * instancias del bot habria que moverlo a Redis o a una tabla.
 */

export type ExpenseField = "amount" | "merchant" | "category" | "card" | "date"

/** Campos que siempre se le piden al usuario, en este orden. */
const BASE_ASKABLE_FIELDS: ExpenseField[] = ["amount", "category", "merchant"]

/**
 * Que campos preguntarle al usuario segun su contexto.
 *
 * La tarjeta SOLO se pregunta si tiene 2 o mas: con una sola (o ninguna) no
 * hace falta decirla y el flujo sigue de largo (la completa `completeHiddenFields`).
 * Si el usuario ya la mencionó en el mensaje, tampoco se vuelve a preguntar.
 */
function askableFields(context: BotContext): ExpenseField[] {
  const fields = [...BASE_ASKABLE_FIELDS]
  const hasForcedCard = Boolean(process.env.BOT_DEFAULT_CARD?.trim())
  // Preguntar la tarjeta solo si hay varias y no hay una fija configurada.
  if (!hasForcedCard && context.linkedCards.length >= 2) fields.push("card")
  return fields
}

/**
 * Con `false` el gasto se publica apenas estan los tres datos.
 * Poner en `true` para volver al paso de "¿lo confirmo? SI / NO".
 */
const REQUIRE_CONFIRMATION = false

interface Session {
  expense: Partial<CreateTransactionInput>
  startedByMessageId: string
  sourceMessageIds: string[]
  rawTexts: string[]
  askingField?: ExpenseField
  awaitingConfirmation: boolean
  /** epoch ms de la ultima actividad, para expirar conversaciones abandonadas. */
  updatedAt: number
}

export interface SessionOutcome {
  /** Texto a responder por WhatsApp (vacio si se publica el gasto). */
  reply: string
  /** Si esta presente, hay que publicarlo en el backend. */
  confirmed?: ConfirmedExpensePayload
}

/**
 * Conversaciones en curso, en memoria. Es estado de prototipo: se pierde si el
 * bot se reinicia y no se comparte entre instancias (para eso iria Redis o una
 * tabla). Se expira lo abandonado para no crecer sin limite.
 */
const sessions = new Map<string, Session>()
const SESSION_TTL_MS = 15 * 60 * 1000

export function clearSession(userId: string) {
  sessions.delete(userId)
}

/** True si hay una conversacion (borrador) en curso para el usuario. */
export function hasActiveDraft(userId: string): boolean {
  return sessions.has(userId)
}

/**
 * Ultimo gasto REALMENTE registrado por usuario, para poder deshacerlo si el
 * bot entendio mal o el usuario se arrepiente. Es aparte de la conversacion:
 * vive despues de publicar el gasto, con su propia expiracion.
 */
interface UndoTarget {
  externalMessageId: string
  detail: string
  at: number
}
const lastRegistered = new Map<string, UndoTarget>()
const UNDO_TTL_MS = 30 * 60 * 1000

/** Marca el ultimo gasto publicado como candidato a deshacer. */
export function rememberLastRegistered(
  userId: string,
  target: { externalMessageId: string; detail: string },
) {
  lastRegistered.set(userId, { ...target, at: Date.now() })
}

/** Devuelve el gasto que se puede deshacer (si no expiro), sin borrarlo. */
export function getUndoTarget(userId: string): { externalMessageId: string; detail: string } | null {
  const target = lastRegistered.get(userId)
  if (!target) return null
  if (Date.now() - target.at > UNDO_TTL_MS) {
    lastRegistered.delete(userId)
    return null
  }
  return { externalMessageId: target.externalMessageId, detail: target.detail }
}

/** Olvida el candidato a deshacer (tras borrarlo, o al registrar otro). */
export function clearUndoTarget(userId: string) {
  lastRegistered.delete(userId)
}

/**
 * Intencion de deshacer/borrar el ultimo gasto: "borralo", "eliminá",
 * "sacalo", "entendiste mal", "esta mal", "deshacelo". Se hace amplio a
 * proposito (es la respuesta esperada a "avisame si querés borrarlo o si
 * entendí mal"), pero sin pisar un "mal" suelto (p. ej. "gasté 1000 en el mall").
 */
export function isUndoIntent(text: string): boolean {
  const clean = normalizeText(text)
  if (/\b(borr|elimin)/.test(clean)) return true
  if (/\bsaca(lo|r)?\b/.test(clean)) return true
  if (/(entendiste|entendi)\s+(mal|cualquiera|otra|todo)/.test(clean)) return true
  if (/(esta|estuvo|quedo)\s+mal/.test(clean)) return true
  if (/\b(deshac|revert|rollback)/.test(clean)) return true
  return false
}

/** Borra las conversaciones sin actividad por mas de SESSION_TTL_MS. */
function sweepExpiredSessions(now: number) {
  for (const [userId, session] of sessions) {
    if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(userId)
  }
}

// ---------- helpers de texto ----------

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
}

function normalizeCommand(value: string) {
  return normalizeText(value).replace(/[^\w\s]/g, "")
}

const CONFIRM_WORDS = ["si", "sii", "sip", "ok", "oka", "dale", "confirmo", "confirmar", "correcto", "esta bien", "listo"]
const CANCEL_WORDS = ["no", "nop", "cancelar", "cancela", "cancelalo", "descartar", "descarta", "borrar", "borra", "olvidalo"]

function isConfirm(text: string) {
  return CONFIRM_WORDS.includes(text)
}

function isCancel(text: string) {
  return CANCEL_WORDS.includes(text)
}

// ---------- parsers por campo ----------

function parseAmountAnswer(text: string): number | undefined {
  const clean = normalizeText(text)

  const withUnit = clean.match(/(\d+(?:[.,]\d+)?)\s*(lucas?|k|mil)\b/)
  if (withUnit) {
    const base = Number(withUnit[1].replace(",", "."))
    return Number.isFinite(base) ? Math.round(base * 1000) : undefined
  }

  const plain = clean.match(/\b(\d{1,3}(?:[.\s]\d{3})+|\d+(?:[.,]\d{1,2})?)\b/)
  if (!plain) return undefined

  const raw = plain[1].replace(/\s/g, "")
  const value = raw.includes(",")
    ? Number(raw.replace(/\./g, "").replace(",", "."))
    : Number(raw.replace(/\.(?=\d{3}\b)/g, ""))

  return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined
}

function parseMerchantAnswer(text: string): string | undefined {
  const merchant = text.trim().replace(/\s+/g, " ")
  if (merchant.length < 2 || merchant.length > 80) return undefined
  return merchant
}

const CATEGORY_ALIASES: Record<string, string> = {
  supermercado: "super",
  almacen: "super",
  verduleria: "super",
  restaurante: "comida",
  restaurant: "comida",
  delivery: "comida",
  sushi: "comida",
  parrilla: "comida",
  nafta: "transporte",
  combustible: "transporte",
  taxi: "transporte",
  uber: "transporte",
  colectivo: "transporte",
  luz: "servicios",
  gas: "servicios",
  internet: "servicios",
  cafeteria: "cafe",
  ropa: "compras",
  farmacia: "compras",
}

function parseCategoryAnswer(text: string, context: BotContext): string | undefined {
  const clean = normalizeText(text)

  const direct = context.categories.find(
    (category) => normalizeText(category.key) === clean || normalizeText(category.label) === clean,
  )
  if (direct) return direct.key

  const contained = context.categories.find((category) => clean.includes(normalizeText(category.key)))
  if (contained) return contained.key

  for (const [alias, key] of Object.entries(CATEGORY_ALIASES)) {
    if (clean.includes(alias) && context.categories.some((category) => category.key === key)) return key
  }

  return undefined
}

function parseCardAnswer(text: string, context: BotContext): string | undefined {
  const clean = normalizeText(text)

  const byDigits = clean.match(/\b(\d{4})\b/)
  if (byDigits) {
    const card = context.linkedCards.find((item) => item.lastFour === byDigits[1])
    if (card) return card.name
  }

  const exact = context.linkedCards.find((card) => normalizeText(card.name) === clean)
  if (exact) return exact.name

  const partial = context.linkedCards.find((card) =>
    normalizeText(card.name)
      .split(" ")
      .some((word) => word.length >= 4 && clean.includes(word)),
  )
  return partial?.name
}

function applyAnswer(
  field: ExpenseField,
  text: string,
  expense: Partial<CreateTransactionInput>,
  context: BotContext,
): boolean {
  switch (field) {
    case "amount": {
      const amount = parseAmountAnswer(text)
      if (amount == null) return false
      expense.amount = amount
      return true
    }
    case "merchant": {
      const merchant = parseMerchantAnswer(text)
      if (!merchant) return false
      expense.merchant = merchant
      return true
    }
    case "category": {
      const category = parseCategoryAnswer(text, context)
      if (!category) return false
      expense.category = category
      return true
    }
    default:
      return false
  }
}

// ---------- completado automatico ----------

/** Tarjeta por defecto: BOT_DEFAULT_CARD, o la primera del usuario. */
function resolveDefaultCard(context: BotContext): string | undefined {
  const configured = process.env.BOT_DEFAULT_CARD?.trim()
  if (configured) return configured

  return context.linkedCards[0]?.name
}

function completeHiddenFields(expense: Partial<CreateTransactionInput>, context: BotContext, referenceDate: Date) {
  if (!expense.date) expense.date = toLocalISODate(referenceDate)
  if (!expense.card) expense.card = resolveDefaultCard(context)
}

// ---------- armado de mensajes ----------

function getMissingFields(expense: Partial<CreateTransactionInput>, context: BotContext): ExpenseField[] {
  return askableFields(context).filter((field) => {
    if (field === "amount") return !expense.amount || expense.amount <= 0
    return !expense[field]
  })
}

function questionFor(field: ExpenseField, context: BotContext): string {
  switch (field) {
    case "amount":
      return "¿Cuánto gastaste? (solo el monto, por ejemplo 5000)"
    case "category":
      return `¿Qué categoría? Opciones: ${describeCategories(context)}`
    case "merchant":
      return "¿En qué comercio o lugar fue?"
    case "card":
      return `¿Con qué tarjeta pagaste? Opciones: ${describeCards(context)}`
    default:
      return "¿Me lo repetís?"
  }
}

function formatMoney(amount: number): string {
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(amount)
  } catch {
    return `$${amount}`
  }
}

export function describeExpense(expense: { amount: number; merchant: string; category: string }): string {
  return `${formatMoney(expense.amount)} en ${expense.merchant} (${expense.category})`
}

function mergeExpense(
  current: Partial<CreateTransactionInput>,
  next: Partial<CreateTransactionInput>,
): Partial<CreateTransactionInput> {
  return {
    ...current,
    amount: current.amount ?? next.amount,
    merchant: current.merchant ?? next.merchant,
    category: current.category ?? next.category,
    card: current.card ?? next.card,
    date: current.date ?? next.date,
  }
}

function buildConfirmedPayload(
  session: Session,
  userId: string,
  lastMessageId: string,
): ConfirmedExpensePayload {
  const expense = session.expense

  return {
    userId,
    messageId: session.startedByMessageId,
    sourceMessageIds: Array.from(new Set([...session.sourceMessageIds, lastMessageId])),
    confirmedAt: new Date().toISOString(),
    expense: {
      amount: expense.amount!,
      merchant: expense.merchant!,
      category: expense.category!,
      card: expense.card!,
      date: expense.date!,
      description: session.rawTexts.join(" / ").slice(0, 500),
    },
  }
}

// ---------- flujo principal ----------

export interface IncomingBotMessage {
  /** Identificador del usuario en el backend: "whatsapp:+549..." */
  userId: string
  messageId: string
  text: string
  receivedAt?: Date
}

export async function handleIncomingMessage(
  message: IncomingBotMessage,
  ai: AiConfig | null,
  context: BotContext,
): Promise<SessionOutcome> {
  const referenceDate = message.receivedAt ?? new Date()
  const now = referenceDate.getTime()
  const command = normalizeCommand(message.text)

  // Limpia conversaciones abandonadas y descarta la propia si ya expiró.
  sweepExpiredSessions(now)
  const existing = sessions.get(message.userId)

  if (existing && isCancel(command)) {
    sessions.delete(message.userId)
    return { reply: "Listo, lo descarté. Cuando quieras me contás otro gasto 👍" }
  }

  if (existing?.awaitingConfirmation && isConfirm(command)) {
    sessions.delete(message.userId)
    return { reply: "", confirmed: buildConfirmedPayload(existing, message.userId, message.messageId) }
  }

  const session: Session = existing ?? {
    expense: {},
    startedByMessageId: message.messageId,
    sourceMessageIds: [],
    rawTexts: [],
    awaitingConfirmation: false,
    updatedAt: now,
  }

  session.updatedAt = now
  session.sourceMessageIds.push(message.messageId)
  session.rawTexts.push(message.text.trim())
  session.awaitingConfirmation = false

  let understood = true
  let processedAsAnswer = false

  if (session.askingField) {
    // El usuario estaba respondiendo una pregunta puntual.
    if (applyAnswer(session.askingField, message.text, session.expense, context)) {
      // Respuesta valida (permite comercios que el normalizador no conoce).
      session.askingField = undefined
      processedAsAnswer = true
    } else if (parseAmountAnswer(message.text) == null) {
      // No parsea como la respuesta ni parece un gasto nuevo -> se re-pregunta.
      understood = false
      session.askingField = undefined
      processedAsAnswer = true
    } else {
      // Parece un GASTO NUEVO (trae monto), no la respuesta: arranca de cero.
      session.expense = {}
      session.askingField = undefined
    }
  }

  if (!processedAsAnswer) {
    const normalized = normalizeExpenseMessage(
      { userId: message.userId, messageId: message.messageId, rawText: message.text },
      { categories: context.categories, linkedCards: context.linkedCards, referenceDate },
    )
    session.expense = mergeExpense(session.expense, normalized.expense)

    if (ai && getMissingFields(session.expense, context).length > 0) {
      const guess = await guessExpenseWithLlm(message.text, ai, context)
      session.expense = mergeExpense(session.expense, {
        amount: guess.amount,
        merchant: guess.merchant,
        category: guess.category ? parseCategoryAnswer(guess.category, context) : undefined,
        card: guess.card ? parseCardAnswer(guess.card, context) : undefined,
        date: guess.date,
      })
    }
  }

  const missing = getMissingFields(session.expense, context)

  if (missing.length > 0) {
    session.askingField = missing[0]
    sessions.set(message.userId, session)

    const prefix = understood ? "" : "No te entendí. "
    return { reply: `${prefix}${questionFor(missing[0], context)}` }
  }

  // Campos que no se preguntan pero el backend necesita.
  completeHiddenFields(session.expense, context, referenceDate)

  if (!session.expense.card) {
    sessions.delete(message.userId)
    return {
      reply:
        "Tengo el gasto pero no encuentro ningún medio de pago cargado para vos. " +
        "Corré `npm run bot:vincular <tu numero>` y volvé a intentar.",
    }
  }

  if (REQUIRE_CONFIRMATION) {
    session.awaitingConfirmation = true
    sessions.set(message.userId, session)

    return {
      reply: `Anoté ${describeExpense({
        amount: session.expense.amount!,
        merchant: session.expense.merchant!,
        category: session.expense.category!,
      })}. ¿Lo confirmo? Respondé SI o NO.`,
    }
  }

  sessions.delete(message.userId)
  return { reply: "", confirmed: buildConfirmedPayload(session, message.userId, message.messageId) }
}
