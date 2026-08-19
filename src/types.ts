/**
 * Tipos vendorizados desde el proyecto CapsaAI (`src/data/capsa-data.ts`).
 *
 * Se copian acá para que el microservicio del bot sea autónomo y no dependa del
 * repo del backend. Si el backend cambia estos contratos, hay que mantenerlos
 * en sync a mano.
 */

export type CategoryKey = string

export interface CategoryView {
  key: CategoryKey
  label: string
  icon: string
  color: string
  isEssential?: boolean
}

export interface LinkedCard {
  name: string
  lastFour: string
  spend: number
  limit: number
  bestFor: string
  nextBenefit: string
}

export interface CreateTransactionInput {
  amount: number
  merchant: string
  category: CategoryKey
  card: string
  date: string
  description?: string
  periodKey?: string
  source?: "manual" | "whatsapp" | "receipt" | "email" | "import" | "api" | "mock"
  externalMessageId?: string
}

/** Fecha local en formato YYYY-MM-DD (sin desfase de zona horaria). */
export function toLocalISODate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}
