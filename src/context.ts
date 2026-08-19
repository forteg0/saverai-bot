import { CategoryView, LinkedCard } from "./types"

/**
 * Catalogo de categorias y tarjetas que usa el bot.
 *
 * El bot es un modulo autocontenido: su UNICO punto de contacto con el backend
 * es el webhook `POST /webhooks/whatsapp/expenses/confirmed` (el contrato que
 * definio el backend). Para no depender de mas endpoints, las categorias y los
 * medios de pago viven aca, como un catalogo fijo.
 *
 * IMPORTANTE: estos valores tienen que coincidir con lo que el backend valida
 * al publicar el gasto, o lo rechaza:
 *  - categorias: las claves de `server/migrations/001_init.sql` (expense_categories),
 *  - tarjetas:   las que crea `bot/vincular-usuario.ts` (payment_methods).
 * Si el backend cambia sus catalogos, hay que actualizar este archivo.
 */

export interface BotContext {
  categories: CategoryView[]
  linkedCards: LinkedCard[]
}

const CATEGORIES: CategoryView[] = [
  { key: "super", label: "Super", icon: "shopping-cart", color: "#7dd3fc" },
  { key: "comida", label: "Comida", icon: "utensils", color: "#f9a8d4" },
  { key: "transporte", label: "Transporte", icon: "car", color: "#86efac" },
  { key: "servicios", label: "Servicios", icon: "wifi", color: "#c4b5fd" },
  { key: "cafe", label: "Cafe", icon: "coffee", color: "#fcd34d" },
  { key: "compras", label: "Compras", icon: "shopping-bag", color: "#fda4af" },
]

const LINKED_CARDS: LinkedCard[] = [
  { name: "Visa Galicia", lastFour: "1042", spend: 0, limit: 0, bestFor: "", nextBenefit: "" },
  { name: "Master Santander", lastFour: "7781", spend: 0, limit: 0, bestFor: "", nextBenefit: "" },
  { name: "Mercado Pago", lastFour: "2209", spend: 0, limit: 0, bestFor: "", nextBenefit: "" },
]

const CONTEXT: BotContext = {
  categories: CATEGORIES,
  linkedCards: LINKED_CARDS,
}

/**
 * Devuelve el catalogo. Es async y recibe estos parametros para no cambiar la
 * firma que usa el resto del bot: el dia que se quiera leer del backend, se
 * cambia solo esta funcion.
 */
export async function getBotContext(_userId: string, _backendUrl: string): Promise<BotContext> {
  return CONTEXT
}

export function describeCategories(context: BotContext): string {
  return context.categories.map((category) => category.key).join(", ")
}

export function describeCards(context: BotContext): string {
  return context.linkedCards.map((card) => card.name).join(", ")
}
