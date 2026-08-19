import "dotenv/config"
import { readFileSync } from "fs"
import { getBotConfig } from "../src/config"
import { transcribeAudio } from "../src/transcribe"
import { getBotContext } from "../src/context"
import { describeExpense, handleIncomingMessage } from "../src/session"

/**
 * Prueba el pipeline de audio SIN pasar por Meta ni por WhatsApp.
 *
 * Uso:
 *   npx tsx bot/probar-audio.ts <archivo-de-audio> [texto-directo]
 *
 * Ejemplos:
 *   npx tsx bot/probar-audio.ts ~/Downloads/gasto.ogg
 *   npx tsx bot/probar-audio.ts --texto "gaste 5000 en comida en tepanyaki"
 *
 * Transcribe el audio con Whisper (Groq), corre la misma logica de conversacion
 * del bot y muestra que responderia o que gasto publicaria. No escribe en la
 * base ni manda nada por WhatsApp: es solo para ver la IA en accion.
 */

function mimeForFile(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? ""
  if (ext === "ogg" || ext === "opus") return "audio/ogg"
  if (ext === "mp3" || ext === "mpeg") return "audio/mpeg"
  if (ext === "m4a" || ext === "mp4") return "audio/mp4"
  if (ext === "wav") return "audio/wav"
  return "audio/ogg"
}

async function main() {
  const args = process.argv.slice(2)
  const config = getBotConfig()

  let transcript: string

  const textoFlagIndex = args.indexOf("--texto")
  if (textoFlagIndex >= 0) {
    transcript = args.slice(textoFlagIndex + 1).join(" ")
    if (!transcript) {
      console.error('Uso: npx tsx bot/probar-audio.ts --texto "gaste 5000 en comida en tepanyaki"')
      process.exit(1)
    }
    console.log(`\n📝 Texto: "${transcript}"`)
  } else {
    const file = args[0]
    if (!file) {
      console.error("Uso: npx tsx bot/probar-audio.ts <archivo-de-audio>")
      console.error('  o: npx tsx bot/probar-audio.ts --texto "gaste 5000 en comida en tepanyaki"')
      process.exit(1)
    }
    if (!config.ai) {
      console.error("No hay IA configurada (falta GROQ_API_KEY). No puedo transcribir.")
      process.exit(1)
    }

    console.log(`\n🎙  Transcribiendo ${file} con ${config.ai.provider} (${config.ai.whisperModel})...`)
    const buffer = readFileSync(file)
    transcript = await transcribeAudio(buffer, mimeForFile(file), config.ai)
    console.log(`📝 Transcripción: "${transcript}"`)
  }

  // Corre la misma conversacion del bot (sin publicar en el backend).
  const userId = "whatsapp:+549test"
  const context = await getBotContext(userId, config.backendUrl)
  const outcome = await handleIncomingMessage(
    { userId, messageId: `test-${transcript.length}`, text: transcript },
    config.ai,
    context,
  )

  console.log("")
  if (outcome.confirmed) {
    console.log(`✅ El bot publicaría: ${describeExpense(outcome.confirmed.expense)}`)
    console.log(`   detalle: ${JSON.stringify(outcome.confirmed.expense, null, 2)}`)
  } else {
    console.log(`💬 El bot respondería: "${outcome.reply}"`)
    console.log("   (falta algún dato; en un chat real seguirías la conversación)")
  }
  console.log("")
}

main().catch((error) => {
  console.error("Falló la prueba:", error instanceof Error ? error.message : error)
  process.exit(1)
})
