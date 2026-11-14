import { type ReactNode, useEffect, useState } from 'react';
import { type DecisionEquipo, type NotaEquipo, anadirNota, borrarNota, decidirConvocatoria, deshacerDecision, leerMotivos } from './api.ts';

const BOTON = 'rounded-full px-3 py-1 text-sm shadow-sm ring-1 ring-linea hover:bg-papel';

/** "Nos interesa" y "Descartar · motivo" (motivos de un clic y "Otro" con texto). `alCambiar` recibe la decisión nueva (null = deshecha). */
export function BotonesDecision({ id, decision, alCambiar, extra }: { id: string; decision: DecisionEquipo | null; alCambiar: (d: DecisionEquipo | null) => void; /** Más controles al final de la fila (p. ej. «Ver ficha»). */ extra?: ReactNode }) {
  const [motivos, setMotivos] = useState<string[] | null>(null);
  const [eligiendo, setEligiendo] = useState(false);
  const [otro, setOtro] = useState(false);
  const [texto, setTexto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    if (eligiendo && !motivos) leerMotivos().then(setMotivos, (e: Error) => setError(e.message));
  }, [eligiendo, motivos]);

  const hacer = async (tarea: () => Promise<DecisionEquipo | null>) => {
    setOcupado(true);
    setError(null);
    try {
      alCambiar(await tarea());
      setEligiendo(false);
      setOtro(false);
      setTexto('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  };
  const interesa = () => hacer(() => decidirConvocatoria(id, { decision: 'nos_interesa' }));
  const descartar = (motivo: string, detalle?: string) => hacer(() => decidirConvocatoria(id, { decision: 'descartada', motivo, detalle }));
  const deshacer = () => hacer(async () => { await deshacerDecision(id); return null; });

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        {decision?.decision === 'nos_interesa' ? (
          <span className="rounded-md bg-marca-suave px-3 py-1.5 text-sm font-medium text-marca-fuerte ring-1 ring-marca-borde">✓ Nos interesa</span>
        ) : (
          <button type="button" disabled={ocupado} onClick={interesa} className="rounded-md bg-marca px-3 py-1.5 text-sm font-medium text-white hover:bg-marca-fuerte disabled:opacity-60">Nos interesa</button>
        )}
        {decision?.decision === 'descartada' ? (
          <span className="rounded-md bg-fondo-suave px-3 py-1.5 text-sm text-tinta">Descartada · {decision.motivo === 'Otro' ? decision.detalle : decision.motivo}</span>
        ) : (
          <button type="button" disabled={ocupado} onClick={() => setEligiendo(!eligiendo)} aria-expanded={eligiendo} className={`${BOTON} bg-superficie text-tinta`}>Descartar…</button>
        )}
        {decision && <button type="button" disabled={ocupado} onClick={deshacer} className="text-sm text-tinta-suave underline hover:text-tinta">Deshacer</button>}
        {extra}
      </div>
      {eligiendo && decision?.decision !== 'descartada' && (
        <div className="mt-2 rounded-md bg-papel p-3 ring-1 ring-linea">
          <p className="mb-2 text-xs font-medium text-tinta-suave">¿Por qué se descarta?</p>
          <div className="flex flex-wrap gap-2">
            {(motivos ?? []).filter((m) => m !== 'Otro').map((m) => (
              <button key={m} type="button" disabled={ocupado} onClick={() => descartar(m)} className={`${BOTON} bg-superficie`}>{m}</button>
            ))}
            {motivos && <button type="button" disabled={ocupado} onClick={() => setOtro(true)} className={`${BOTON} bg-superficie`}>Otro…</button>}
          </div>
          {otro && (
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (texto.trim()) void descartar('Otro', texto); }}>
              <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Motivo" aria-label="Motivo del descarte" maxLength={500} className="min-w-0 flex-1 rounded-md border border-linea-fuerte px-2 py-1 text-sm" />
              <button type="submit" disabled={ocupado || !texto.trim()} className="rounded-md bg-tinta px-3 py-1 text-sm text-white disabled:opacity-40">Descartar</button>
            </form>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-peligro">{error}</p>}
    </div>
  );
}

const cuando = (iso: string) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

/** Notas del equipo en la ficha: varias, con fecha y autor opcional. */
export function Notas({ id, notas, alCambiar }: { id: string; notas: NotaEquipo[]; alCambiar: (n: NotaEquipo[]) => void }) {
  const [texto, setTexto] = useState('');
  const [autor, setAutor] = useState(() => { try { return localStorage.getItem('radar-autor') ?? ''; } catch { return ''; } });
  const [error, setError] = useState<string | null>(null);

  const enviar = async () => {
    setError(null);
    try {
      const nueva = await anadirNota(id, texto, autor);
      try { localStorage.setItem('radar-autor', autor); } catch { /* sin almacenamiento: da igual */ }
      alCambiar([...notas, nueva]);
      setTexto('');
    } catch (e) { setError((e as Error).message); }
  };
  const borrar = async (n: NotaEquipo) => {
    try { await borrarNota(id, n.id); alCambiar(notas.filter((x) => x.id !== n.id)); } catch (e) { setError((e as Error).message); }
  };

  return (
    <section className="mb-6">
      <h2 className="mb-2 text-lg font-semibold">Notas del equipo</h2>
      {notas.length === 0 && <p className="mb-2 text-sm text-tinta-suave">Todavía no hay notas.</p>}
      <ul className="mb-3 space-y-2">
        {notas.map((n) => (
          <li key={n.id} className="rounded-md bg-superficie p-3 text-sm shadow-sm ring-1 ring-linea">
            <p className="whitespace-pre-line [overflow-wrap:anywhere]">{n.texto}</p>
            <p className="mt-1 flex justify-between gap-2 text-xs text-tinta-suave">
              <span>{n.autor ? `${n.autor} · ` : ''}{cuando(n.creadaEn)}</span>
              <button type="button" onClick={() => borrar(n)} className="underline hover:text-tinta">Borrar</button>
            </p>
          </li>
        ))}
      </ul>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (texto.trim()) void enviar(); }}>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={2} maxLength={2000} placeholder="Añadir una nota" aria-label="Nueva nota" className="w-full rounded-md border border-linea-fuerte px-2 py-1 text-sm" />
        <div className="flex gap-2">
          <input value={autor} onChange={(e) => setAutor(e.target.value)} placeholder="Tu nombre (opcional)" aria-label="Tu nombre" maxLength={80} className="min-w-0 flex-1 rounded-md border border-linea-fuerte px-2 py-1 text-sm" />
          <button type="submit" disabled={!texto.trim()} className="rounded-md bg-marca px-3 py-1 text-sm text-white disabled:opacity-40">Añadir nota</button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-peligro">{error}</p>}
    </section>
  );
}
