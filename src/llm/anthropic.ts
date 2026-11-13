// LLM real: Claude vía el SDK oficial, con salida estructurada (JSON Schema) para que la respuesta sea tipada.
import Anthropic from '@anthropic-ai/sdk';
import type { Llm, PeticionLlm, RespuestaLlm } from './llm.ts';

export function crearLlmAnthropic(opciones: { apiKey: string }): Llm {
  const client = new Anthropic({ apiKey: opciones.apiKey, maxRetries: 4 });

  return {
    async generar(p: PeticionLlm): Promise<RespuestaLlm> {
      const r = await client.beta.messages.create({
        model: p.modelo,
        max_tokens: p.maxTokens,
        system: p.sistema,
        messages: [{ role: 'user', content: p.mensaje }],
        // Criba: decisión corta, poco razonamiento. Análisis: lectura atenta de bases largas.
        output_config: { effort: p.tarea === 'criba' ? 'low' : 'medium', format: { type: 'json_schema', schema: p.esquema } },
        // Si el modelo de análisis rechaza por un falso positivo de seguridad, la API reintenta con el de reserva.
        ...(p.tarea === 'analisis' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (r.stop_reason === 'refusal') throw new Error(`El modelo rechazó la petición (${r.stop_details?.category ?? 'sin categoría'})`);
      if (r.stop_reason === 'max_tokens') throw new Error(`Respuesta cortada por max_tokens (${p.maxTokens})`);
      const texto = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      let datos: unknown;
      try {
        datos = JSON.parse(texto);
      } catch {
        throw new Error(`Respuesta sin JSON válido: ${texto.slice(0, 200)}`);
      }
      return {
        datos,
        modelo: r.model,
        uso: {
          entrada: r.usage.input_tokens,
          salida: r.usage.output_tokens,
          cacheLectura: r.usage.cache_read_input_tokens ?? 0,
          cacheEscritura: r.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
