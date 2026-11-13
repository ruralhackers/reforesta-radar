// Emisor de correo: la interfaz que usa el motor (se inyecta; los tests usan uno falso) y el real, Resend por HTTP
// (sin dependencias: un POST a https://api.resend.com/emails).
export interface CorreoSaliente {
  de: string;
  para: string[];
  asunto: string;
  html: string;
  texto: string;
}

export interface Emisor {
  /** Devuelve el id del proveedor (null si no lo da). Lanza si el envío falla. */
  enviar(correo: CorreoSaliente): Promise<{ id: string | null }>;
}

export function crearEmisorResend({ apiKey, fetch: f = globalThis.fetch }: { apiKey: string; fetch?: typeof globalThis.fetch }): Emisor {
  return {
    async enviar(c) {
      const r = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: c.de, to: c.para, subject: c.asunto, html: c.html, text: c.texto }),
      });
      const cuerpo = await r.text();
      if (!r.ok) throw new Error(`Resend respondió ${r.status}: ${cuerpo.slice(0, 300)}`);
      let id: string | null = null;
      try { id = (JSON.parse(cuerpo) as { id?: string }).id ?? null; } catch { /* sin id */ }
      return { id };
    },
  };
}
