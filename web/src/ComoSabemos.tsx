import { useEffect, useState } from 'react';
import { type Backtest, type BacktestFilaA, type BacktestModo, leerBacktest } from './api.ts';

const fecha = (dia: string) => new Date(`${dia}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
const ETAPA: Record<string, string> = {
  reglas: 'Descartada por las reglas', criba_llm: 'Descartada por la criba', analisis: 'Descartada en el análisis', puntuacion: 'Excluida por la puntuación',
  sin_datos: 'BDNS no la devolvió', pendiente: 'Criba sin hacer',
};

function Veredicto({ f }: { f: BacktestFilaA }) {
  const r = f.resultado;
  if (!r) return <span className="rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600">Sin calcular</span>;
  if (!r.completa) return <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Provisional</span>;
  return r.exito
    ? <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">Detectada</span>
    : <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">No detectada</span>;
}

const si = (b: boolean) => (b ? 'Sí' : 'No');

function FilaA({ f }: { f: BacktestFilaA }) {
  const r = f.resultado;
  return (
    <li className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">{f.etiqueta ?? f.titulo}</p>
          <h3 className="font-semibold [overflow-wrap:anywhere]"><a href={f.urlBdns} className="hover:underline" target="_blank" rel="noreferrer">{f.titulo}</a></h3>
          <p className="text-sm text-stone-600">Publicada en BDNS el {fecha(f.fechaPublicacion)} (BDNS {f.numero})</p>
        </div>
        <Veredicto f={f} />
      </div>
      {f.notas.map((n) => <p key={n} className="mt-1 text-xs text-stone-600">{n}</p>)}
      {r && (
        <dl className="mt-3 grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
          <div><dt className="text-xs text-stone-500">Pasa las reglas</dt><dd>{si(r.pasoReglas)}</dd></div>
          <div><dt className="text-xs text-stone-500">Pasa la criba</dt><dd>{si(r.pasoCriba)}</dd></div>
          <div><dt className="text-xs text-stone-500">Puntuación (solo dato)</dt><dd>{r.puntuacion !== null ? `${r.puntuacion} / 100` : '—'}</dd></div>
        </dl>
      )}
      {r && (r.motivoCriba || r.motivoReglas) && <p className="mt-2 text-sm text-stone-700">{r.pasoCriba ? 'Criba: ' : `${ETAPA[r.etapa] ?? r.etapa}: `}{r.motivoReglas ?? r.motivoCriba}</p>}
      {r && r.factores.length > 0 && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-emerald-800">Cómo se puntuó</summary>
          <ul className="mt-1 space-y-1">
            {r.factores.map((x) => <li key={x.nombre}><span className="font-medium">{x.nombre}</span> (peso {x.peso}, {Math.round(x.subpuntuacion * 100)} %{x.conocido ? '' : ', desconocido'}): {x.explicacion}</li>)}
          </ul>
        </details>
      )}
    </li>
  );
}

function Barras({ datos }: { datos: { etiqueta: string; n: number }[] }) {
  const max = Math.max(1, ...datos.map((d) => d.n));
  return (
    <ul className="space-y-1" aria-label="Distribución de puntuaciones">
      {datos.map((d) => (
        <li key={d.etiqueta} className="flex items-center gap-2 text-sm">
          <span className="w-28 shrink-0 text-stone-600">{d.etiqueta}</span>
          <span className="h-3 rounded bg-emerald-600" style={{ width: `${(100 * d.n) / max}%`, minWidth: d.n ? 4 : 0 }} />
          <span className="tabular-nums">{d.n}</span>
        </li>
      ))}
    </ul>
  );
}

function Modo({ m, bt }: { m: BacktestModo; bt: Backtest }) {
  const met = m.b.metrica;
  return (
    <>
      <section className="mb-8 rounded-lg bg-emerald-50 p-4 ring-1 ring-emerald-200">
        <p className="text-lg font-semibold">{m.titular}</p>
        {m.titularB && <p className="mt-2 text-sm">{m.titularB}</p>}
        <p className="mt-2 text-xs text-stone-600">
          {m.modo === 'sin_analisis' ? 'Puntuado solo con lo que se sabe sin leer los documentos (sin Sonnet): el encaje, el importe y el esfuerzo cuentan como desconocidos, por eso el máximo posible es bajo.' : 'Con análisis de los documentos (Sonnet).'}
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-xl font-semibold">(a) Convocatorias conocidas</h2>
        <p className="mb-3 text-sm text-stone-600">
          Las cinco ediciones de la convocatoria de la Comunidad de Madrid de «proyectos ambientales» y el ejemplo del MITECO (la Orden 1689/2026 del reto es el extracto de la 904719).
          Éxito = detectada: pasa las reglas y la criba, así que aparece en «Esta semana», que lista todas las convocatorias abiertas. {m.a.exitos} de {m.a.total} lo consiguen.
          La puntuación se muestra como dato, no como criterio.
        </p>
        <ul className="space-y-3">{m.a.filas.map((f) => <FilaA key={f.numero} f={f} />)}</ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-1 text-xl font-semibold">(b) Lo que ganan organizaciones parecidas</h2>
        <p className="mb-3 text-sm text-stone-600">
          Convocatorias que, desde 2022, ganaron organizaciones parecidas a Reforesta, elegidas solo con reglas objetivas (abajo) y con el radar funcionando <strong>sin</strong> la
          fuente «las ganan organizaciones como vosotros», así que no sabe quién las ganó.
        </p>
        {met.procesadas === 0 ? <p className="rounded bg-white p-3 text-sm shadow-sm">Todavía no hay resultados de este conjunto.</p> : (
          <div className="space-y-4">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded bg-white p-3 shadow-sm ring-1 ring-stone-200"><dt className="text-xs text-stone-500">Pasan la criba</dt><dd className="text-2xl font-bold">{met.porcentajePasaCriba} %</dd><dd className="text-xs text-stone-500">{met.pasanCriba} de {met.procesadas}</dd></div>
              <div className="rounded bg-white p-3 shadow-sm ring-1 ring-stone-200"><dt className="text-xs text-stone-500">Puntuación mediana</dt><dd className="text-2xl font-bold">{met.medianaPuntuacion ?? '—'}</dd><dd className="text-xs text-stone-500">entre las que pasan</dd></div>
              <div className="rounded bg-white p-3 shadow-sm ring-1 ring-stone-200"><dt className="text-xs text-stone-500">Cumplen las reglas objetivas</dt><dd className="text-2xl font-bold">{met.conjunto}</dd><dd className="text-xs text-stone-500">de {m.b.examinadas} examinadas</dd></div>
            </dl>
            <div className="rounded bg-white p-4 shadow-sm ring-1 ring-stone-200">
              <h3 className="mb-2 font-semibold">Puntuación de las {met.pasanCriba} que pasan la criba</h3>
              <Barras datos={met.distribucion} />
            </div>
          </div>
        )}
        <p className="mt-3 text-sm text-stone-600">
          Conjunto: {met.conjunto} convocatorias cumplen las reglas ({m.b.examinadas} examinadas){met.procesadas < met.conjunto ? `; ${met.procesadas} con resultado definitivo` : ''}
          {met.provisionales ? `, ${met.provisionales} provisionales (criba sin terminar)` : ''}{met.sinProcesar ? `, ${met.sinProcesar} sin procesar todavía (tope por ejecución)` : ''}
          {met.sinDatos ? `, ${met.sinDatos} que BDNS no devolvió` : ''}. «Reforesta no figura entre los ganadores» no quiere decir que se presentara y perdiera: BDNS solo publica quién ganó.
        </p>

        <details className="mt-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
          <summary className="cursor-pointer font-medium text-emerald-800">Las reglas objetivas que decidieron el conjunto</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            <li>Registrada en BDNS desde 2022 (las concesiones solo existen desde entonces).</li>
            <li>Ni nominativa ni concesión directa (tipo de convocatoria o título).</li>
            <li>Ámbito del perfil: nivel estatal, Comunidad de Madrid o región del perfil.</li>
            <li>Finalidad ambiental: alguna de estas palabras en título, órgano o finalidad: {bt.reglasB.palabrasAmbientales.join(', ')}.</li>
            <li>Admite entidades sin ánimo de lucro: la ganó una organización parecida y el título no la limita a empresas, autónomos o administraciones.</li>
            <li>No la ganó Reforesta y no es una del conjunto (a).</li>
          </ol>
          {m.b.excluidas.length > 0 && (
            <p className="mt-2 text-sm text-stone-600">Examinadas y excluidas: {m.b.excluidas.map((e) => `${e.n} · ${e.motivo}`).join('; ')}.</p>
          )}
        </details>

        <details className="mt-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
          <summary className="cursor-pointer font-medium text-emerald-800">El conjunto, convocatoria a convocatoria ({m.b.filas.length})</summary>
          <ul className="mt-2 space-y-3">
            {m.b.filas.map((f) => (
              <li key={f.numero} className="border-t border-stone-100 pt-2 text-sm first:border-0 first:pt-0">
                <p className="font-medium [overflow-wrap:anywhere]"><a href={f.urlBdns} className="hover:underline" target="_blank" rel="noreferrer">{f.titulo}</a></p>
                <p className="text-xs text-stone-600">{f.organo} · {fecha(f.fechaPublicacion)} · BDNS {f.numero} · la ganó: {f.ganadoras.join(', ')}</p>
                <p className="text-xs text-stone-600">Admitida por: {f.reglas.join(' · ')}</p>
                <p className="text-xs">
                  {!f.procesada ? 'Sin procesar todavía.'
                    : f.pasoCriba ? `Pasa la criba · puntuación ${f.puntuacion ?? '—'}`
                    : `No pasa: ${ETAPA[f.etapa ?? ''] ?? f.etapa}${f.motivo ? `: ${f.motivo}` : ''}`}
                </p>
              </li>
            ))}
          </ul>
        </details>
      </section>
    </>
  );
}

export function ComoSabemos() {
  const [bt, setBt] = useState<Backtest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { leerBacktest().then(setBt, (e: Error) => setError(e.message)); }, []);
  const m = bt?.modos.sin_analisis;
  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700"><a href="/" className="hover:underline">Radar de convocatorias</a></p>
        <h1 className="text-2xl font-bold sm:text-3xl">Cómo sabemos que funciona</h1>
        <p className="mt-1 text-sm text-stone-600">
          Es una <strong>reclasificación</strong>, no una reproducción de lo que pasó: tomamos convocatorias del pasado, les pasamos las reglas, la criba y la puntuación <em>de hoy</em>
          con el reloj en el día en que se publicaron, y miramos si el radar las habría detectado. Repetible con <code>npm run backtest</code>.
        </p>
        <p className="mt-2 text-sm text-stone-600">
          Límites: el conjunto conocido es pequeño (unas pocas convocatorias, no una estadística), y el segundo depende de reglas objetivas que hemos escrito nosotros
          (una lista de palabras ambientales, ámbito y tipo de concesión), de modo que mide lo que esas reglas dejan ver y no todo lo que existe.
          Además, el porcentaje que pasa la criba en (b) no es una precisión: el conjunto está prefiltrado por palabras clave, no tiene control negativo (convocatorias que no deberían encajar)
          y se juzga con los documentos y el perfil de hoy.
        </p>
      </header>
      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-red-800">{error}</p>}
      {!bt && !error && <p className="text-stone-500">Cargando…</p>}
      {bt && !m && <p className="rounded-md bg-white p-4 text-stone-600 shadow-sm">Todavía no se ha ejecutado el backtest. Ejecuta <code>npm run backtest</code>.</p>}
      {bt && m && <Modo m={m} bt={bt} />}
      {bt?.modos.con_analisis && (
        <section className="mb-8"><h2 className="mb-2 text-xl font-semibold">Variante con análisis de los documentos</h2><Modo m={bt.modos.con_analisis} bt={bt} /></section>
      )}
      {bt && m && (
        <footer className="text-xs text-stone-500">
          <p>El factor «probabilidad» queda neutro (sin ganadores previos, para no mirar al futuro). Llamadas reales al LLM: {m.coste.llamadas} · coste: {m.coste.costeUsd} USD ·
            generado el {new Date(bt.generadoEn).toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}.</p>
        </footer>
      )}
    </main>
  );
}
