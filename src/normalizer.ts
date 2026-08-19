import { CategoryKey, CategoryView, CreateTransactionInput, LinkedCard, toLocalISODate } from "./types"

export interface IncomingExpenseMessage {
  userId: string
  messageId: string
  rawText: string
  sentAt?: string
}

export interface ExpenseNormalizationContext {
  categories: CategoryView[]
  linkedCards: LinkedCard[]
  referenceDate?: Date
}

export type ExpenseNormalizationStatus = "needs_input" | "ready_to_confirm" | "needs_review"

export interface NormalizedExpenseResult {
  expense: Partial<CreateTransactionInput>
  confidence: number
  status: ExpenseNormalizationStatus
  missingFields: Array<keyof CreateTransactionInput>
  reviewReasons: string[]
  rawText: string
}

interface MerchantRule {
  merchant: string
  category: CategoryKey
  aliases: string[]
}

interface AmountMatch {
  amount: number
  confidence: number
}

const merchantRules: MerchantRule[] = [
  { merchant: "Coto", category: "super", aliases: ["coto"] },
  { merchant: "Carrefour", category: "super", aliases: ["carrefour", "carre"] },
  { merchant: "Disco", category: "super", aliases: ["disco"] },
  { merchant: "Dia", category: "super", aliases: ["dia", "super dia"] },
  { merchant: "YPF", category: "transporte", aliases: ["ypf"] },
  { merchant: "Shell", category: "transporte", aliases: ["shell"] },
  { merchant: "Uber", category: "transporte", aliases: ["uber"] },
  { merchant: "Cabify", category: "transporte", aliases: ["cabify"] },
  { merchant: "Rappi", category: "comida", aliases: ["rappi"] },
  { merchant: "PedidosYa", category: "comida", aliases: ["pedidos ya", "pedidosya"] },
  { merchant: "Mostaza", category: "comida", aliases: ["mostaza"] },
  { merchant: "Cafe Martinez", category: "cafe", aliases: ["cafe martinez", "martinez"] },
  { merchant: "Starbucks", category: "cafe", aliases: ["starbucks"] },
  { merchant: "Farmacity", category: "compras", aliases: ["farmacity"] },
  { merchant: "Zara", category: "compras", aliases: ["zara"] },
  { merchant: "Netflix", category: "servicios", aliases: ["netflix"] },
  { merchant: "Personal", category: "servicios", aliases: ["personal"] },
  { merchant: "Edenor", category: "servicios", aliases: ["edenor"] },
]

const categoryAliases: Record<string, CategoryKey> = {
  super: "super",
  supermercado: "super",
  supermecado: "super",
  comida: "comida",
  restaurant: "comida",
  restaurante: "comida",
  delivery: "comida",
  transporte: "transporte",
  nafta: "transporte",
  combustible: "transporte",
  taxi: "transporte",
  servicios: "servicios",
  servicio: "servicios",
  luz: "servicios",
  internet: "servicios",
  cafe: "cafe",
  cafeteria: "cafe",
  compras: "compras",
  compra: "compras",
  ropa: "compras",
}

const numberWords: Record<string, number> = {
  un: 1,
  una: 1,
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900,
}

const dateAliases = {
  hoy: 0,
  ayer: -1,
  anteayer: -2,
}

export function normalizeExpenseMessage(
  message: IncomingExpenseMessage,
  context: ExpenseNormalizationContext,
): NormalizedExpenseResult {
  const text = normalizeText(message.rawText)
  const referenceDate = message.sentAt ? new Date(message.sentAt) : context.referenceDate ?? new Date()
  const amount = extractAmount(text)
  const merchant = extractMerchant(text)
  const category = merchant?.category ?? extractCategory(text, context.categories)
  const card = extractCard(text, context.linkedCards)
  const date = extractDate(text, referenceDate)

  const expense: Partial<CreateTransactionInput> = {
    amount: amount?.amount,
    merchant: merchant?.merchant,
    category,
    card: card?.lastFour,
    date: toLocalISODate(date),
    description: message.rawText.trim(),
  }

  const missingFields = getMissingFields(expense)
  const confidence = scoreConfidence({ amount, merchantFound: Boolean(merchant), categoryFound: Boolean(category), cardFound: Boolean(card), missingFields })
  const status = getNormalizationStatus(confidence, missingFields)
  const reviewReasons = getReviewReasons(confidence, missingFields)

  return {
    expense,
    confidence,
    status,
    missingFields,
    reviewReasons,
    rawText: message.rawText,
  }
}

function normalizeText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
}

function extractAmount(text: string): AmountMatch | null {
  const compactMatch = text.match(/(?:\$|ars)?\s*(\d+(?:[.,]\d+)?)\s*(lucas?|k|mil)\b/)
  if (compactMatch) {
    return { amount: Math.round(parseAmountNumber(compactMatch[1], true) * 1000), confidence: 0.95 }
  }

  const moneyMatch = text.match(/(?:\$|ars|por|gaste|gasto|pague|pago|compre)\s*(\d{1,3}(?:[.\s]\d{3})+|\d+(?:[.,]\d{1,2})?)(?:\s*pesos?)?/)
  if (moneyMatch) {
    return { amount: Math.round(parseAmountNumber(moneyMatch[1], false)), confidence: 0.88 }
  }

  const pesosMatch = text.match(/\b(\d{1,3}(?:[.\s]\d{3})+|\d+)\s*pesos?\b/)
  if (pesosMatch) {
    return { amount: Math.round(parseAmountNumber(pesosMatch[1], false)), confidence: 0.82 }
  }

  const numericMatch = text.match(/\b(\d{1,3}(?:[.\s]\d{3})+)\b/)
  if (numericMatch) {
    return { amount: Math.round(parseAmountNumber(numericMatch[1], false)), confidence: 0.68 }
  }

  const wordAmount = extractWordAmount(text)
  if (wordAmount) return wordAmount

  return null
}

function extractWordAmount(text: string): AmountMatch | null {
  const tokens = text.split(/\s+/)
  const unitIndex = tokens.findIndex((token) => ["luca", "lucas", "mil", "peso", "pesos"].includes(token))
  if (unitIndex <= 0) return null

  for (let size = Math.min(5, unitIndex); size >= 1; size -= 1) {
    const phrase = tokens.slice(unitIndex - size, unitIndex).join(" ")
    const wordsAmount = parseSpanishNumberWords(phrase)
    if (wordsAmount) {
      const unit = tokens[unitIndex]
      const multiplier = unit.startsWith("luca") || unit === "mil" ? 1000 : 1
      return { amount: wordsAmount * multiplier, confidence: 0.72 }
    }
  }

  return null
}

function parseAmountNumber(value: string, allowDecimalDot: boolean) {
  const withoutSpaces = value.replace(/\s/g, "")
  if (withoutSpaces.includes(",")) return Number(withoutSpaces.replace(/\./g, "").replace(",", "."))
  if (allowDecimalDot && /^\d+\.\d{1,2}$/.test(withoutSpaces)) return Number(withoutSpaces)

  return Number(withoutSpaces.replace(/\./g, ""))
}

function parseSpanishNumberWords(phrase: string) {
  const tokens = phrase
    .split(/\s+/)
    .filter((token) => token && token !== "y" && token !== "de")

  if (tokens.length === 0) return null

  const total = tokens.reduce((sum, token) => {
    const value = numberWords[token]
    return value == null ? Number.NaN : sum + value
  }, 0)

  return Number.isFinite(total) && total > 0 ? total : null
}

function extractMerchant(text: string) {
  for (const rule of merchantRules) {
    if (rule.aliases.some((alias) => containsWord(text, alias))) return rule
  }

  return null
}

function extractCategory(text: string, categories: CategoryView[]) {
  for (const [alias, category] of Object.entries(categoryAliases)) {
    if (containsWord(text, alias) && categories.some((item) => item.key === category)) {
      return category
    }
  }

  return undefined
}

function extractCard(text: string, linkedCards: LinkedCard[]) {
  const lastFourMatch = text.match(/\b(\d{4})\b/)
  if (lastFourMatch) {
    const cardByDigits = linkedCards.find((card) => card.lastFour === lastFourMatch[1])
    if (cardByDigits) return cardByDigits
  }

  return linkedCards.find((card) => {
    const normalizedName = normalizeText(card.name)
    const nameParts = normalizedName.split(/\s+/)
    return nameParts.some((part) => part.length >= 4 && containsWord(text, part))
  })
}

function extractDate(text: string, referenceDate: Date) {
  for (const [word, offset] of Object.entries(dateAliases)) {
    if (containsWord(text, word)) return addDays(referenceDate, offset)
  }

  return referenceDate
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function containsWord(text: string, word: string) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\b${escaped}\\b`).test(text)
}

function getMissingFields(expense: Partial<CreateTransactionInput>) {
  const missingFields: Array<keyof CreateTransactionInput> = []
  if (!expense.amount || expense.amount <= 0) missingFields.push("amount")
  if (!expense.merchant) missingFields.push("merchant")
  if (!expense.category) missingFields.push("category")
  if (!expense.card) missingFields.push("card")
  if (!expense.date) missingFields.push("date")

  return missingFields
}

function scoreConfidence(input: {
  amount: AmountMatch | null
  merchantFound: boolean
  categoryFound: boolean
  cardFound: boolean
  missingFields: Array<keyof CreateTransactionInput>
}) {
  let score = 0
  if (input.amount) score += input.amount.confidence * 0.35
  if (input.merchantFound) score += 0.25
  if (input.categoryFound) score += 0.2
  if (input.cardFound) score += 0.15
  if (input.missingFields.length === 0) score += 0.05

  return Math.round(score * 100) / 100
}

function getNormalizationStatus(confidence: number, missingFields: Array<keyof CreateTransactionInput>): ExpenseNormalizationStatus {
  if (missingFields.length > 0) return "needs_input"
  if (confidence < 0.75) return "needs_review"

  return "ready_to_confirm"
}

function getReviewReasons(confidence: number, missingFields: Array<keyof CreateTransactionInput>) {
  const reasons: string[] = missingFields.map((field) => `missing_${field}`)
  if (confidence < 0.75) reasons.push("low_confidence")

  return reasons
}
