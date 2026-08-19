import { AiConfig } from "./config"

/**
 * Transcripcion del audio de WhatsApp (OGG/Opus) con Whisper.
 * Funciona con Groq (gratis) o con OpenAI: la API es la misma.
 */

function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg") || mimeType.includes("opus")) return "ogg"
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3"
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a"
  if (mimeType.includes("wav")) return "wav"
  return "ogg"
}

export async function transcribeAudio(buffer: Buffer, mimeType: string, ai: AiConfig): Promise<string> {
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), `audio.${extensionFor(mimeType)}`)
  form.append("model", ai.whisperModel)
  form.append("language", "es")
  form.append("response_format", "text")

  const response = await fetch(`${ai.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ai.apiKey}` },
    body: form,
  })

  if (!response.ok) {
    throw new Error(`Transcripcion (${ai.provider}) fallo: ${response.status} ${await response.text()}`)
  }

  const text = (await response.text()).trim()
  if (!text) throw new Error("La transcripcion volvio vacia")
  return text
}
