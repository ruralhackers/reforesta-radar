import { type FormEvent, useEffect, useState } from 'react';
import { useSesion } from './Sesion.tsx';
import { guardarPerfil, leerPerfil, type PerfilWeb } from './api.ts';

const NIVELES = ['ESTADO', 'AUTONOMICA', 'LOCAL', 'OTROS'];
const aLista = (t: string) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const entrada = 'w-full rounded border border-stone-300 px-3 py-2 text-sm';

/** Perfil de la organización: lo que leen las reglas, la criba, el análisis y la puntuación en la siguiente ejecución. */
export function Perfil() {
  const { puedeEditar } = useSesion();
  const [perfil, setPerfil] = useState<PerfilWeb | null>(null);
  const [lineas, setLineas] = useState<{ nombre: string; descripcion: string }[]>([]);
  const [descripcion, setDescripcion] = useState('');
  const [niveles, setNiveles] = useState<string[]>([]);
  const [comunidades, setComunidades] = useState('');
  const [regiones, setRegiones] = useState('');
  const [otras, setOtras] = useState(false);
  const [importe, setImporte] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const cargar = (p: PerfilWeb) => {
    setPerfil(p); setLineas(p.lineas); setDescripcion(p.ambito.descripcion); setNiveles(p.ambito.nivelesSiempre);
    setComunidades(p.ambito.comunidades.join('\n')); setRegiones(p.ambito.regiones.join(', '));
    setOtras(p.ambito.otrasComunidadesSiNoExigenSede === true); setImporte(p.importeMinimo === null ? '' : String(p.importeMinimo));
  };
  useEffect(() => { leerPerfil().then(cargar, (e: Error) => setError(e.message)); }, []);

  const cambiarLinea = (i: number, campo: 'nombre' | 'descripcion', v: string) => setLineas(lineas.map((l, j) => (j === i ? { ...l, [campo]: v } : l)));

  async function enviar(ev: FormEvent) {
    ev.preventDefault();
    setOcupado(true); setError(null); setOk(false);
    try {
      const n = importe.trim() === '' ? null : Number(importe.replace(',', '.'));
      if (n !== null && Number.isNaN(n)) throw new Error('El importe mínimo debe ser un número');
      cargar(await guardarPerfil({
        lineas,
        ambito: { descripcion, nivelesSiempre: niveles, comunidades: aLista(comunidades), regiones: aLista(regiones), otrasComunidadesSiNoExigenSede: otras },
        importeMinimo: n,
      }));
      setOk(true);
    } catch (e) { setError((e as Error).message); } finally { setOcupado(false); }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
      <header className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700"><a href="/" className="hover:underline">Radar de convocatorias</a></p>
        <h1 className="text-2xl font-bold sm:text-3xl">Perfil</h1>
        <p className="mt-1 text-sm text-stone-600">
          Lo que el radar sabe de la organización. Los cambios cuentan desde la siguiente ejecución: si cambias las líneas o el ámbito, se vuelve a
          cribar (y, si cambian las líneas, a analizar) lo visto en los últimos 30 días; lo anterior conserva su veredicto. El orden de las líneas
          no cuenta. El importe mínimo se aplica enseguida a la puntuación.
        </p>
      </header>

      {error && <p role="alert" className="mb-4 rounded-md bg-red-50 p-3 text-red-800">{error}</p>}
      {ok && <p role="status" className="mb-4 rounded-md bg-emerald-50 p-3 text-emerald-900">Perfil guardado. Se usará en la siguiente ejecución del radar.</p>}
      {perfil && !puedeEditar && <p className="mb-4 rounded-md bg-stone-100 p-3 text-sm text-stone-700">Solo el equipo puede editar el perfil: entra con «Acceso equipo».</p>}
      {!perfil && !error && <p className="text-stone-500">Cargando…</p>}

      {perfil && (
        <form onSubmit={(ev) => void enviar(ev)} className="space-y-6">
          <fieldset disabled={!puedeEditar} className="space-y-6">
          <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
            <h2 className="font-semibold">{perfil.nombre}</h2>
            <p className="mt-1 text-xs text-stone-500">NIF {perfil.nif}{perfil.bdnsIdPersona !== null && ` · idPersona en BDNS ${perfil.bdnsIdPersona}`} (solo lectura)</p>
          </section>

          <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
            <h2 className="mb-2 font-semibold">Líneas de trabajo</h2>
            <ul className="space-y-3">
              {lineas.map((l, i) => (
                <li key={i} className="space-y-2 rounded border border-stone-200 p-3">
                  <input value={l.nombre} onChange={(e) => cambiarLinea(i, 'nombre', e.target.value)} aria-label={`Nombre de la línea ${i + 1}`} placeholder="Nombre" className={entrada} />
                  <textarea value={l.descripcion} onChange={(e) => cambiarLinea(i, 'descripcion', e.target.value)} aria-label={`Descripción de la línea ${i + 1}`} placeholder="Qué se hace en esta línea" rows={3} className={entrada} />
                  <button type="button" onClick={() => setLineas(lineas.filter((_, j) => j !== i))} className="text-xs text-red-700 hover:underline">Quitar línea</button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setLineas([...lineas, { nombre: '', descripcion: '' }])} className="mt-3 text-sm text-emerald-800 hover:underline">+ Añadir línea</button>
          </section>

          <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
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
            <label className="block text-sm">Comunidades autónomas admitidas (una por línea)
              <textarea value={comunidades} onChange={(e) => setComunidades(e.target.value)} rows={2} className={`mt-1 ${entrada}`} />
            </label>
            <label className="block text-sm">Regiones NUTS admitidas, para ayuntamientos y otros órganos locales (p. ej. ES30, ES300)
              <input value={regiones} onChange={(e) => setRegiones(e.target.value)} className={`mt-1 ${entrada}`} />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={otras} onChange={(e) => setOtras(e.target.checked)} className="mt-1" />
              <span>Aceptar convocatorias de otras comunidades si no exigen sede ni actividad allí (las revisa la criba)</span>
            </label>
          </section>

          <section className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200">
            <label className="block text-sm font-semibold">Importe mínimo (euros)
              <input value={importe} onChange={(e) => setImporte(e.target.value)} inputMode="decimal" placeholder="Sin mínimo" className={`mt-1 font-normal sm:w-52 ${entrada}`} />
            </label>
            <p className="mt-1 text-xs text-stone-500">Por debajo de esta cantidad una convocatoria puntúa menos: no merece el esfuerzo.</p>
          </section>

          {puedeEditar && <button type="submit" disabled={ocupado} className="w-full rounded bg-emerald-700 px-4 py-2 font-medium text-white disabled:opacity-50 sm:w-auto">{ocupado ? 'Guardando…' : 'Guardar perfil'}</button>}
          </fieldset>
        </form>
      )}
    </main>
  );
}
