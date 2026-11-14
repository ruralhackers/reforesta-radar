import { type ReactNode, useEffect, useState } from 'react';
import { leerContadores, leerNosInteresa } from './api.ts';
import { AccesoEquipo, useSesion } from './Sesion.tsx';

/** Dónde estamos: marca el enlace activo del menú. La ficha cuelga de "Esta semana". */
const activa = (ruta: string, ahora: string) => (ruta === '/' ? ahora === '/' || ahora.startsWith('/convocatoria/') : ahora.startsWith(ruta));

interface Enlace { ruta: string; texto: string; contador?: string }

function Menu({ ahora, cuenta }: { ahora: string; cuenta: Record<string, string | undefined> }) {
  const puedeEditar = useSesion().puedeEditar;
  const principal: Enlace[] = [
    { ruta: '/', texto: 'Esta semana', contador: cuenta['/'] },
    ...(puedeEditar ? [{ ruta: '/nos-interesa', texto: 'Nos interesa', contador: cuenta['/nos-interesa'] }] : []),
    { ruta: '/empresas', texto: 'Empresas', contador: cuenta['/empresas'] },
  ];
  const ajustes: Enlace[] = [
    { ruta: '/perfil', texto: 'Perfil' },
    { ruta: '/fundaciones', texto: 'Fundaciones' },
    { ruta: '/parecidas', texto: 'Organizaciones parecidas' },
  ];
  const fila = (e: Enlace) => (
    <li key={e.ruta}>
      <a
        href={e.ruta}
        aria-current={activa(e.ruta, ahora) ? 'page' : undefined}
        className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-white/10 ${activa(e.ruta, ahora) ? 'bg-white/15 font-semibold text-white' : 'text-white/90'}`}
      >
        <span>{e.texto}</span>
        {e.contador && <span className="rounded-full bg-white/20 px-2 text-xs tabular-nums text-white">{e.contador}</span>}
      </a>
    </li>
  );
  return (
    <nav aria-label="Principal" className="flex-1 overflow-y-auto px-3 py-2">
      <ul className="space-y-1">{principal.map(fila)}</ul>
      <p className="mt-5 mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-white/70">Ajustes</p>
      <ul className="space-y-1">{ajustes.map(fila)}</ul>
      <div className="my-4 border-t border-white/15" />
      <ul>{fila({ ruta: '/como-sabemos', texto: 'Cómo sabemos' })}</ul>
    </nav>
  );
}

/** Marco de todas las pantallas: barra lateral (menú hamburguesa en móvil), contenido y pie. */
export function Layout({ children }: { children: ReactNode }) {
  const ahora = window.location.pathname.replace(/\/+$/, '') || '/';
  const [abierto, setAbierto] = useState(false);
  const [cuenta, setCuenta] = useState<Record<string, string | undefined>>({});
  const { puedeEditar } = useSesion();

  useEffect(() => {
    leerContadores().then((c) => setCuenta((x) => ({ ...x, '/': String(c.estaSemana), '/empresas': String(c.empresas) })), () => { /* sin contadores: el menú sale igual */ });
  }, []);
  useEffect(() => {
    if (!puedeEditar) return;
    leerNosInteresa().then((l) => setCuenta((x) => ({ ...x, '/nos-interesa': String(l.length) })), () => { /* sin acceso: sin contador */ });
  }, [puedeEditar]);
  useEffect(() => {
    if (!abierto) return;
    const cerrar = (e: KeyboardEvent) => { if (e.key === 'Escape') setAbierto(false); };
    window.addEventListener('keydown', cerrar);
    return () => window.removeEventListener('keydown', cerrar);
  }, [abierto]);

  const marca = (
    <a href="/" className="block px-4 py-4 text-lg font-bold leading-tight tracking-tight text-white">
      Radar para Reforesta
    </a>
  );

  return (
    <div className="md:flex md:min-h-screen">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-superficie focus:px-3 focus:py-2 focus:text-tinta focus:shadow-lg">Saltar al contenido</a>

      {/* Móvil: barra superior con hamburguesa; el menú se despliega debajo. */}
      <header className="sobre-oscuro sticky top-0 z-40 bg-marca-lateral md:hidden">
        <div className="flex items-center justify-between pr-2">
          {marca}
          <button
            type="button" onClick={() => setAbierto(!abierto)} aria-expanded={abierto} aria-controls="menu-principal"
            aria-label={abierto ? 'Cerrar el menú' : 'Abrir el menú'}
            className="rounded-md p-2 text-white hover:bg-white/10"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {abierto ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
        <div id="menu-principal" hidden={!abierto} className="max-h-[75vh] overflow-y-auto border-t border-white/15 pb-2">
          <Menu ahora={ahora} cuenta={cuenta} />
          <div className="px-4 pb-3"><AccesoEquipo /></div>
        </div>
      </header>

      {/* Escritorio: la columna con el fondo se estira hasta el final de la página (aunque sea larga); el menú se queda fijo a la altura de la ventana. */}
      <aside className="sobre-oscuro hidden w-64 shrink-0 bg-marca-lateral md:block">
        <div className="md:sticky md:top-0 md:flex md:h-screen md:flex-col">
          {marca}
          <Menu ahora={ahora} cuenta={cuenta} />
          <div className="border-t border-white/15 px-4 py-3"><AccesoEquipo /></div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main id="contenido" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-8 sm:py-10">{children}</main>
        <footer className="border-t border-linea px-4 py-4 text-center text-xs text-tinta-suave sm:px-8">
          hecho por Rural Hackers · Common Seeds
        </footer>
      </div>
    </div>
  );
}
