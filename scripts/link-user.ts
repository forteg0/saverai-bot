import "dotenv/config"
import { Pool } from "pg"
import { canonicalArgentinaDigits } from "../src/meta"

/**
 * Da de alta un usuario de WhatsApp y sus medios de pago (utilidad de desarrollo).
 *
 * Uso:
 *   npx tsx bot/vincular-usuario.ts +5493513796700
 *
 * El backend identifica al usuario por `app_users.whatsapp_user_id` con el
 * formato "whatsapp:+549...". Sin esta fila, el backend rechaza el gasto con
 * `unknown_user`. Las tarjetas que crea coinciden con bot/context.ts.
 */

const DEFAULT_CARDS: Array<{ label: string; lastFour: string }> = [
  { label: "Visa Galicia", lastFour: "1042" },
  { label: "Master Santander", lastFour: "7781" },
  { label: "Mercado Pago", lastFour: "2209" },
]

async function main() {
  const rawPhone = process.argv[2]
  if (!rawPhone) {
    console.error("Uso: npx tsx bot/vincular-usuario.ts +5493513796700")
    process.exit(1)
  }

  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error("Falta DATABASE_URL en el .env")
    process.exit(1)
  }

  const digits = canonicalArgentinaDigits(rawPhone.replace(/[^\d]/g, ""))
  const whatsappUserId = `whatsapp:+${digits}`
  const pool = new Pool({ connectionString })

  try {
    const user = await pool.query<{ id: string }>(
      `
        INSERT INTO app_users (whatsapp_user_id)
        VALUES ($1)
        ON CONFLICT (whatsapp_user_id) DO UPDATE SET whatsapp_user_id = EXCLUDED.whatsapp_user_id
        RETURNING id
      `,
      [whatsappUserId],
    )

    const userId = Number(user.rows[0]!.id)

    for (const card of DEFAULT_CARDS) {
      await pool.query(
        `
          INSERT INTO payment_methods (user_id, label, last_four)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, last_four) DO UPDATE
          SET label = EXCLUDED.label, active = true
        `,
        [userId, card.label, card.lastFour],
      )
    }

    console.log(`Usuario ${whatsappUserId} listo (id ${userId}).`)
    console.log(`Tarjetas: ${DEFAULT_CARDS.map((card) => `${card.label} (${card.lastFour})`).join(", ")}`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
