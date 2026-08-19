import { AiConfig } from "./config"
import { BotContext } from "./context"

/**
 * Ayuda opcional de IA para completar los campos que el normalizador por reglas
 * no pudo sacar del texto.
 *
 * El normalizador de `normalizer.ts` reconoce una lista fija de
 * comercios; para todo lo demas (un sushi en "Tepanyaki", por ejemplo) haria falta
 * preguntarle al usuario campo por campo. Este modulo intenta primero deducirlo
 * del mismo mensaje, y solo se pregunta lo que sigue faltando.
 *
 * Es un apoyo, no una autoridad: el backend siempre revalida todo.
 */

export interface LlmExpenseGuess {
  amount?: number
  merchant?: string
  category?: string
  card?: string
  date?: string
}

function buildSystemPrompt(context: BotContext): string {
  return `Extraes datos de un gasto a partir de un mensaje en espanol rioplatense (Argentina).
Devolves SOLO un JSON con las claves que puedas deducir con seguridad; si un dato no esta, omitilo.

{
  "amount": number,     // monto en pesos. "dos mil"=2000, "2 lucas"=2000, "2 palos"=2000000
  "merchant": string,   // nombre del comercio o lugar
  "category": string,   // UNA de: ${context.categories.map((category) => category.key).join(", ")}
  "card": string,       // UNA de: ${context.linkedCards.map((card) => card.name).join(" | ")}
  "date": string        // YYYY-MM-DD si se menciona una fecha concreta
}

Reglas: no inventes datos que no aparecen en el mensaje. Sin markdown, solo el JSON.`
}

function extractJsonObject(content: string): string {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  return start >= 0 && end > start ? content.slice(start, end + 1) : content
}

export async function guessExpenseWithLlm(
  rawText: string,
  ai: AiConfig,
  context: BotContext,
): Promise<LlmExpenseGuess> {
  try {
    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ai.chatModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(context) },
          { role: "user", content: rawText },
        ],
      }),
    })

    if (!response.ok) {
      console.error("LLM fallo:", response.status, await response.text())
      return {}
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) return {}

    const raw = JSON.parse(extractJsonObject(content)) as Record<string, unknown>
    const amount = Number(raw.amount)

    return {
      amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : undefined,
      merchant: typeof raw.merchant === "string" && raw.merchant.trim() ? raw.merchant.trim() : undefined,
      category: typeof raw.category === "string" ? raw.category.trim().toLowerCase() : undefined,
      card: typeof raw.card === "string" && raw.card.trim() ? raw.card.trim() : undefined,
      date: typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : undefined,
    }
  } catch (error) {
    console.error("LLM error:", error)
    return {}
  }
}
