import { type FormEvent, useEffect, useState } from 'react';
import { useSesion } from './Sesion.tsx';
import { guardarPerfil, leerMemorias, leerPerfil, type MemoriasWeb, type PerfilWeb } from './api.ts';

const NIVELES = ['ESTADO', 'AUTONOMICA', 'LOCAL', 'OTROS'];
const aLista = (t: string) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
/** Un territorio por línea: "Comunidad: provincia, provincia" (sin provincias = toda la comunidad). */
const aTerritorios = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [comunidad, resto = ''] = l.split(':');
  return { comunidad: comunidad.trim(), provincias: aLista(resto) };
});
const deTerritorios = (ts: { comunidad: string; provincias: string[] }[]) => ts.map((t) => (t.provincias.length ? `${t.comunidad}: ${t.provincias.join(', ')}` : t.comunidad)).join('\n');
const entrada = 'w-full rounded-md border border-linea-fuerte bg-superficie px-3 py-2 text-sm';

/** Perfil de la organización: lo que leen las reglas, la criba, el análisis y la puntuación en la siguiente ejecución. */
export function Perfil() {
  const { puedeEditar } = useSesion();
  const [perfil, setPerfil] = useState<PerfilWeb | null>(null);
  const [lineas, setLineas] = useState<{ nombre: string; descripcion: string }[]>([]);
  const [descripcion, setDescripcion] = useState('');
  const [niveles, setNiveles] = useState<string[]>([]);
  const [territorios, setTerritorios] = useState('');
  const [regiones, setRegiones] = useState('');
  const [domicilio, setDomicilio] = useState({ municipio: '', provincia: '', comunidad: '', distrito: '' });
  const [importe, setImporte] = useState('');
  const [umbral, setUmbral] = useState('50');
  const [memorias, setMemorias] = useState('');
  const [paginaMemorias, setPaginaMemorias] = useState('');
  const [resumen, setResumen] = useState<MemoriasWeb | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const cargar = (p: PerfilWeb) => {
    setPerfil(p); setLineas(p.lineas); setDescripcion(p.ambito.descripcion); setNiveles(p.ambito.nivelesSiempre);
    setTerritorios(deTerritorios(p.ambito.territorios)); setRegiones(p.ambito.regiones.join(', '));
    setDomicilio({ municipio: p.domicilio?.municipio ?? '', provincia: p.domicilio?.provincia ?? '', comunidad: p.domicilio?.comunidad ?? '', distrito: p.domicilio?.distrito ?? '' });
    setImporte(p.importeMinimo === null ? '' : String(p.importeMinimo));
    setUmbral(String(p.umbralEncaje));
    setMemorias(p.memorias.join('\n')); setPaginaMemorias(p.paginaMemorias ?? '');
  };
  useEffect(() => { leerPerfil().then(cargar, (e: Error) => setError(e.message)); leerMemorias().then(setResumen, () => {}); }, []);

  const cambiarLinea = (i: number, campo: 'nombre' | 'descripcion', v: string) => setLineas(lineas.map((l, j) => (j === i ? { ...l, [campo]: v } : l)));

  async function enviar(ev: FormEvent) {
    ev.preventDefault();
    setOcupado(true); setError(null); setOk(false);
    try {
      const n = importe.trim() === '' ? null : Number(importe.replace(',', '.'));
      if (n !== null && Number.isNaN(n)) throw new Error('El importe mínimo debe ser un número');
      const u = Number(umbral);
      if (umbral.trim() === '' || !Number.isInteger(u) || u < 0 || u > 100) throw new Error('El umbral de encaje debe ser un número entero entre 0 y 100');
      const hayDomicilio = Object.values(domicilio).some((v) => v.trim());
      cargar(await guardarPerfil({
        ...(hayDomicilio ? { domicilio: { municipio: domicilio.municipio, provincia: domicilio.provincia, comunidad: domicilio.comunidad, ...(domicilio.distrito.trim() ? { distrito: domicilio.distrito } : {}) } } : {}),
        lineas,
        ambito: { descripcion, nivelesSiempre: niveles, territorios: aTerritorios(territorios), comunidades: [], regiones: aLista(regiones) },
        importeMinimo: n,
        umbralEncaje: u,
        memorias: aLista(memorias), paginaMemorias: paginaMemorias.trim() || null,
      }));
      leerMemorias().then(setResumen, () => {});
      setOk(true);
    } catch (e) { setError((e as Error).message); } finally { setOcupado(false); }
  }

  return (
    <div className="max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Perfil</h1>
        <p className="mt-1 text-sm text-tinta-suave">
          Lo que el radar sabe de la organización. Los cambios cuentan desde la siguiente ejecución: si cambias las líneas o el ámbito, se vuelve a
          cribar (y, si cambian las líneas, a analizar) lo visto en los últimos 30 días; lo anterior conserva su veredicto. El orden de las líneas
          no cuenta. El importe mínimo se aplica enseguida a la puntuación.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-peligro-suave p-3 text-peligro">{error}</p>}
      {ok && <p role="status" className="mb-4 rounded-md bg-marca-suave p-3 text-marca-fuerte">Perfil guardado. Se usará en la siguiente ejecución del radar.</p>}
      {perfil && !puedeEditar && <p className="mb-4 rounded-md bg-fondo-suave p-3 text-sm text-tinta">Solo el equipo puede editar el perfil: entra con «Acceso equipo».</p>}
      {!perfil && !error && <p className="text-tinta-suave">Cargando…</p>}

      {perfil && (
        <form onSubmit={(ev) => void enviar(ev)} className="space-y-6">
          <fieldset disabled={!puedeEditar} className="space-y-6">
          <section className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <h2 className="font-semibold">{perfil.nombre}</h2>
            <p className="mt-1 text-xs text-tinta-suave">NIF {perfil.nif}{perfil.bdnsIdPersona !== null && ` · idPersona en BDNS ${perfil.bdnsIdPersona}`} (solo lectura)</p>
          </section>

          <section className="space-y-3 rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <h2 className="font-semibold">Domicilio social</h2>
            <p className="text-xs text-tinta-suave">Dónde está registrada la entidad (su aviso legal). Las convocatorias que exigen sede, domicilio o inscripción en otro municipio o distrito se descartan en la criba.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {([['municipio', 'Municipio'], ['provincia', 'Provincia'], ['comunidad', 'Comunidad autónoma'], ['distrito', 'Distrito (opcional)']] as const).map(([k, etiqueta]) => (
                <label key={k} className="block text-sm">{etiqueta}
                  <input value={domicilio[k]} onChange={(e) => setDomicilio({ ...domicilio, [k]: e.target.value })} className={`mt-1 ${entrada}`} />
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <h2 className="mb-2 font-semibold">Líneas de trabajo</h2>
            <ul className="space-y-3">
              {lineas.map((l, i) => (
                <li key={i} className="space-y-2 rounded border border-linea p-3">
                  <input value={l.nombre} onChange={(e) => cambiarLinea(i, 'nombre', e.target.value)} aria-label={`Nombre de la línea ${i + 1}`} placeholder="Nombre" className={entrada} />
                  <textarea value={l.descripcion} onChange={(e) => cambiarLinea(i, 'descripcion', e.target.value)} aria-label={`Descripción de la línea ${i + 1}`} placeholder="Qué se hace en esta línea" rows={3} className={entrada} />
                  <button type="button" onClick={() => setLineas(lineas.filter((_, j) => j !== i))} className="text-xs text-peligro hover:underline">Quitar línea</button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setLineas([...lineas, { nombre: '', descripcion: '' }])} className="mt-3 text-sm text-marca-fuerte hover:underline">+ Añadir línea</button>
          </section>

          <section className="space-y-3 rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <h2 className="font-semibold">Ámbito geográfico</h2>
            <label className="block text-sm">Descripción
              <textarea value={descripcion} onChange={(e) => setDescripcion(e.target.value)} rows={2} className={`mt-1 ${entrada}`} />
            </label>
            <fieldset>
              <legend className="text-sm">Niveles de administración que siempre se admiten</legend>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {NIVELES.map((n) => (
                  <label key={n} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={niveles.includes(n)} onChange={(e) => setNiveles(e.target.checked ? [...niveles, n] : niveles.filter((x) => x !== n))} />{n}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block text-sm">Ámbito de actuación: territorios donde se pueden ejecutar los proyectos (uno por línea; «Comunidad: provincia, provincia», o solo la comunidad si vale entera)
              <textarea value={territorios} onChange={(e) => setTerritorios(e.target.value)} rows={4} className={`mt-1 ${entrada}`} />
            </label>
            <p className="text-xs text-tinta-suave">Lo que importa es dónde se hace el proyecto, no la sede. Estatales y europeas valen siempre; las autonómicas, solo de estas comunidades (si solo valen algunas provincias, la criba comprueba que la convocatoria las admita); las locales, solo de diputaciones de estas provincias o de las regiones NUTS de abajo.</p>
            <label className="block text-sm">Regiones NUTS admitidas, para ayuntamientos y otros órganos locales (p. ej. ES30 Madrid, ES416 Segovia, ES411 Ávila, ES424 Guadalajara, ES425 Toledo, ES423 Cuenca)
              <input value={regiones} onChange={(e) => setRegiones(e.target.value)} className={`mt-1 ${entrada}`} />
            </label>
          </section>

          <section className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <label className="block text-sm font-semibold">Importe mínimo (euros)
              <input value={importe} onChange={(e) => setImporte(e.target.value)} inputMode="decimal" placeholder="Sin mínimo" className={`mt-1 font-normal sm:w-52 ${entrada}`} />
            </label>
            <p className="mt-1 text-xs text-tinta-suave">Por debajo de esta cantidad una convocatoria puntúa menos: no merece el esfuerzo.</p>
          </section>

          <section className="rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <label className="block text-sm font-semibold">Encaje mínimo para «Esta semana» (0 a 100)
              <input value={umbral} onChange={(e) => setUmbral(e.target.value)} inputMode="numeric" className={`mt-1 font-normal sm:w-32 ${entrada}`} />
            </label>
            <p className="mt-1 text-xs text-tinta-suave">«Esta semana» solo pone arriba (hasta 7) las convocatorias ya analizadas con al menos esta puntuación; el resto queda plegado en «El radar vio otras…». Se aplica enseguida.</p>
          </section>

          <section className="space-y-3 rounded-[var(--radio)] bg-superficie p-4 ring-1 ring-linea">
            <h2 className="font-semibold">Memorias</h2>
            <p className="text-xs text-tinta-suave">
              Las memorias anuales de la entidad (PDF o web, una dirección por línea). El radar las lee una vez para saber qué habéis hecho de verdad (proyectos y
              financiadores, con cita) y lo usa en la criba, en la idea de proyecto, en «Experiencia relacionada» de cada ficha y para marcar a quien ya os financió.
              La lectura la hace el motor (o <code>npm run memorias</code>), no esta página: se retoma en la siguiente ejecución.
            </p>
            <label className="block text-sm">Direcciones de las memorias
              <textarea value={memorias} onChange={(e) => setMemorias(e.target.value)} rows={5} className={`mt-1 font-mono text-xs ${entrada}`} />
            </label>
            <label className="block text-sm">Página donde se publican (opcional: de ella se descubren las memorias nuevas, como mucho una vez a la semana)
              <input value={paginaMemorias} onChange={(e) => setPaginaMemorias(e.target.value)} type="url" placeholder="https://…" className={`mt-1 ${entrada}`} />
            </label>
            {resumen && resumen.memorias.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="mb-1 text-left text-xs text-tinta-suave">Leído hasta ahora: {resumen.totales.proyectos} proyectos y {resumen.totales.financiadores} financiadores en {resumen.memorias.length} memorias.</caption>
                  <thead className="text-xs text-tinta-suave"><tr><th className="py-1 pr-3 font-medium">Año</th><th className="py-1 pr-3 font-medium">Proyectos</th><th className="py-1 pr-3 font-medium">Financiadores</th><th className="py-1 font-medium">Memoria</th></tr></thead>
                  <tbody>
                    {resumen.memorias.map((m) => (
                      <tr key={m.url} className="border-t border-linea">
                        <td className="py-1 pr-3">{m.anio ?? '—'}</td><td className="py-1 pr-3">{m.proyectos}</td><td className="py-1 pr-3">{m.financiadores}</td>
                        <td className="py-1"><a href={m.url} target="_blank" rel="noreferrer" className="text-marca-fuerte hover:underline">Abrir</a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {resumen && resumen.pendientes.length > 0 && <p className="text-xs text-tinta-suave">Pendientes de leer: {resumen.pendientes.length} (se leen en la siguiente ejecución del radar o con <code>npm run memorias</code>).</p>}
            {resumen && resumen.memorias.length === 0 && resumen.enLista.length === 0 && <p className="text-xs text-tinta-suave">Sin memorias todavía.</p>}
          </section>

          {puedeEditar && <button type="submit" disabled={ocupado} className="w-full rounded bg-marca px-4 py-2 font-medium text-white hover:bg-marca-fuerte disabled:opacity-50 sm:w-auto">{ocupado ? 'Guardando…' : 'Guardar perfil'}</button>}
          </fieldset>
        </form>
      )}
    </div>
  );
}
