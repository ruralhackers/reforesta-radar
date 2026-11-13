import { useEffect, useState } from 'react';
import { type DecisionEquipo, type NotaEquipo, anadirNota, borrarNota, decidirConvocatoria, deshacerDecision, leerMotivos } from './api.ts';

const BOTON = 'rounded-full px-3 py-1 text-sm shadow-sm ring-1 ring-stone-200 hover:bg-stone-50';

/** "Nos interesa" y "Descartar · motivo" (motivos de un clic y "Otro" con texto). `alCambiar` recibe la decisión nueva (null = deshecha). */
export function BotonesDecision({ id, decision, alCambiar }: { id: string; decision: DecisionEquipo | null; alCambiar: (d: DecisionEquipo | null) => void }) {
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
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-900">Nos interesa</span>
        ) : (
          <button type="button" disabled={ocupado} onClick={interesa} className={`${BOTON} bg-white text-emerald-800`}>Nos interesa</button>
        )}
        {decision?.decision === 'descartada' ? (
          <span className="rounded-full bg-stone-200 px-3 py-1 text-sm text-stone-700">Descartada · {decision.motivo === 'Otro' ? decision.detalle : decision.motivo}</span>
        ) : (
          <button type="button" disabled={ocupado} onClick={() => setEligiendo(!eligiendo)} aria-expanded={eligiendo} className={`${BOTON} bg-white text-stone-700`}>Descartar…</button>
        )}
        {decision && <button type="button" disabled={ocupado} onClick={deshacer} className="text-sm text-stone-500 underline hover:text-stone-800">Deshacer</button>}
      </div>
      {eligiendo && decision?.decision !== 'descartada' && (
        <div className="mt-2 rounded-md bg-stone-50 p-3 ring-1 ring-stone-200">
          <p className="mb-2 text-xs font-medium text-stone-500">¿Por qué se descarta?</p>
          <div className="flex flex-wrap gap-2">
            {(motivos ?? []).filter((m) => m !== 'Otro').map((m) => (
              <button key={m} type="button" disabled={ocupado} onClick={() => descartar(m)} className={`${BOTON} bg-white`}>{m}</button>
            ))}
            {motivos && <button type="button" disabled={ocupado} onClick={() => setOtro(true)} className={`${BOTON} bg-white`}>Otro…</button>}
          </div>
          {otro && (
            <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (texto.trim()) void descartar('Otro', texto); }}>
              <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Motivo" maxLength={500} className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1 text-sm" />
              <button type="submit" disabled={ocupado || !texto.trim()} className="rounded-md bg-stone-800 px-3 py-1 text-sm text-white disabled:opacity-40">Descartar</button>
            </form>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
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
      {notas.length === 0 && <p className="mb-2 text-sm text-stone-500">Todavía no hay notas.</p>}
      <ul className="mb-3 space-y-2">
        {notas.map((n) => (
          <li key={n.id} className="rounded-md bg-white p-3 text-sm shadow-sm ring-1 ring-stone-200">
            <p className="whitespace-pre-line [overflow-wrap:anywhere]">{n.texto}</p>
            <p className="mt-1 flex justify-between gap-2 text-xs text-stone-500">
              <span>{n.autor ? `${n.autor} · ` : ''}{cuando(n.creadaEn)}</span>
              <button type="button" onClick={() => borrar(n)} className="underline hover:text-stone-800">Borrar</button>
            </p>
          </li>
        ))}
      </ul>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (texto.trim()) void enviar(); }}>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={2} maxLength={2000} placeholder="Añadir una nota" className="w-full rounded-md border border-stone-300 px-2 py-1 text-sm" />
        <div className="flex gap-2">
          <input value={autor} onChange={(e) => setAutor(e.target.value)} placeholder="Tu nombre (opcional)" maxLength={80} className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1 text-sm" />
          <button type="submit" disabled={!texto.trim()} className="rounded-md bg-emerald-700 px-3 py-1 text-sm text-white disabled:opacity-40">Añadir nota</button>
        </div>
      </form>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
