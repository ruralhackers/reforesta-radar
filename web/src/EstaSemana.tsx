import { useEffect, useState } from 'react';
import { type ConvocatoriaSemana, type DecisionEquipo, type Semana, leerDecisiones, leerSemana, rutaFicha } from './api.ts';
import { BotonesDecision } from './Decision.tsx';
import { useSesion } from './Sesion.tsx';
import { Nota } from './Puntuacion.tsx';
import { Cierre } from './Plazo.tsx';
import { OrigenFuente } from './Origen.tsx';

const fecha = (dia: string) =>
  new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });

const instante = (iso: string) =>
  new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

const SECCIONES: { id: 'cierran_pronto' | 'nuevas' | 'abiertas'; titulo: string; ayuda: (s: Semana) => string }[] = [
  { id: 'cierran_pronto', titulo: 'Cierran pronto', ayuda: (s) => `Cierre en ${s.cierranProntoDias} días o menos, por puntuación.` },
  { id: 'nuevas', titulo: 'Nuevas', ayuda: (s) => `Vistas por primera vez en los últimos ${s.nuevasDias} días y que no cierran pronto, por puntuación.` },
  { id: 'abiertas', titulo: 'Abiertas', ayuda: () => 'El resto de convocatorias abiertas que encajan, con cierre lejano o desconocido, por puntuación.' },
];

const nombresParecidas = (c: ConvocatoriaSemana) => c.parecidas?.organizaciones.map((o) => o.nombre).join(', ') ?? '';

/** Etiqueta de las convocatorias que ganan organizaciones parecidas (en cualquier sección). */
function Parecidas({ c }: { c: ConvocatoriaSemana }) {
  if (!c.parecidas) return null;
  return (
    <p className="mt-2 text-xs text-amber-900">
      <span className="rounded bg-amber-100 px-2 py-0.5 font-medium">La ganan organizaciones como vosotros</span>{' '}
      {c.parecidas.descubierta ? 'La hemos encontrado por ' : 'Entre los ganadores previos: '}{nombresParecidas(c)}
    </p>
  );
}

export function EstaSemana() {
  const [semana, setSemana] = useState<Semana | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { puedeEditar } = useSesion();
  const [decisiones, setDecisiones] = useState<Map<string, DecisionEquipo>>(new Map());

  useEffect(() => {
    leerSemana().then(setSemana, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!puedeEditar) { setDecisiones(new Map()); return; }
    leerDecisiones().then((ds) => setDecisiones(new Map(ds.map((d) => [d.convocatoriaId, d]))), () => { /* sin acceso al equipo: sin botones marcados */ });
  }, [puedeEditar]);

  // Descartar la quita de la lista (el servidor ya no la devuelve); "nos interesa" solo marca la fila.
  const alCambiar = (id: string, d: DecisionEquipo | null) => {
    setDecisiones((m) => { const n = new Map(m); if (d) n.set(id, d); else n.delete(id); return n; });
    if (d?.decision === 'descartada') setSemana((s) => s && { ...s, convocatorias: s.convocatorias.filter((c) => c.id !== id), lasGananParecidas: s.lasGananParecidas.filter((x) => x !== id) });
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">Radar de convocatorias</p>
        <h1 className="text-2xl font-bold sm:text-3xl">Esta semana</h1>
        <p className="mt-1 text-sm"><a href="/parecidas" className="text-emerald-800 hover:underline">Ajustar las organizaciones parecidas</a> · <a href="/fundaciones" className="text-emerald-800 hover:underline">Fundaciones</a> · <a href="/empresas" className="text-emerald-800 hover:underline">Empresas</a> · <a href="/perfil" className="text-emerald-800 hover:underline">Perfil</a> · <a href="/como-sabemos" className="text-emerald-800 hover:underline">Cómo sabemos</a>{puedeEditar && <> · <a href="/nos-interesa" className="text-emerald-800 hover:underline">Nos interesa</a></>}</p>
        {semana && (
          <p className="mt-1 text-sm text-stone-600">
            Del {fecha(semana.desde)} al {fecha(semana.hasta)} · {semana.convocatorias.length} candidatas, abiertas, ordenadas por puntuación
          </p>
        )}
      </header>

      {error && <p className="rounded-md bg-red-50 p-4 text-red-800">No se pudo cargar la lista: {error}</p>}
      {!semana && !error && <p className="text-stone-500">Cargando…</p>}

      {semana && semana.convocatorias.length === 0 && (
        <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">No hay convocatorias candidatas esta semana.</p>
      )}

      {semana && semana.lasGananParecidas.length > 0 && (
        <section className="mb-8 rounded-lg bg-amber-50 p-4 ring-1 ring-amber-200">
          <h2 className="text-lg font-semibold">Las ganan organizaciones como vosotros <span className="text-sm font-normal text-stone-500">({semana.lasGananParecidas.length})</span></h2>
          <p className="mb-3 text-sm text-stone-600">Convocatorias abiertas que han ganado organizaciones parecidas (o que hemos encontrado por ellas). Aparecen también en su sección de abajo.</p>
          <ul className="space-y-2">
            {semana.lasGananParecidas.map((id) => semana.convocatorias.find((c) => c.id === id)).filter((c): c is ConvocatoriaSemana => !!c).map((c) => (
              <li key={c.id} className="rounded-md bg-white p-3 ring-1 ring-stone-200">
                <div className="flex items-start justify-between gap-3">
                  <a href={rutaFicha(c.id)} className="font-semibold leading-snug text-emerald-800 hover:underline [overflow-wrap:anywhere]">{c.titulo}</a>
                  <Nota puntuacion={c.puntuacion} />
                </div>
                <p className="mt-1 text-xs text-stone-600">{c.parecidas?.descubierta ? 'Encontrada por' : 'Ganadores previos:'} {nombresParecidas(c)} · <Cierre plazo={c.plazo} /></p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {semana && SECCIONES.map(({ id, titulo, ayuda }) => {
        const lista = semana.convocatorias.filter((c) => c.seccion === id);
        if (lista.length === 0) return null;
        return (
          <section key={id} className="mb-8">
            <h2 className="text-lg font-semibold">{titulo} <span className="text-sm font-normal text-stone-500">({lista.length})</span></h2>
            <p className="mb-3 text-sm text-stone-600">{ayuda(semana)}</p>
            <ul className="space-y-3">
              {lista.map((c) => (
                <li key={c.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
                  <div className="flex items-start justify-between gap-3">
                    <a href={rutaFicha(c.id)} className="font-semibold leading-snug text-emerald-800 hover:underline [overflow-wrap:anywhere]">
                      {c.titulo}
                    </a>
                    <Nota puntuacion={c.puntuacion} />
                  </div>
                  <p className="mt-1 text-sm text-stone-600">{c.organo}</p>
                  <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-stone-500">
                    <span>{fecha(c.fechaPublicacion)}</span>
                    <OrigenFuente fuente={c.fuente} url={c.url} />
                    <Cierre plazo={c.plazo} />
                  </p>
                  <Parecidas c={c} />
                  {puedeEditar && <BotonesDecision id={c.id} decision={decisiones.get(c.id) ?? null} alCambiar={(d) => alCambiar(c.id, d)} />}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {semana?.ultimaEjecucion && (
        <footer className="mt-8 border-t border-stone-200 pt-4 text-xs text-stone-500">
          Última revisión: {instante(semana.ultimaEjecucion.inicio)}
          {semana.ultimaEjecucion.estado === 'con_errores' && ' · con errores en alguna fuente'}
        </footer>
      )}
    </main>
  );
}
