import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ComoSabemos } from './ComoSabemos.tsx';
import { Empresas } from './Empresas.tsx';
import { EstaSemana } from './EstaSemana.tsx';
import { Ficha } from './Ficha.tsx';
import { Fundaciones } from './Fundaciones.tsx';
import { Layout } from './Layout.tsx';
import { Licitaciones } from './Licitaciones.tsx';
import { NosInteresa } from './NosInteresa.tsx';
import { Parecidas } from './Parecidas.tsx';
import { Perfil } from './Perfil.tsx';
import './index.css';

// Pantallas: "Esta semana" (/), la ficha (/convocatoria/<id>), las organizaciones parecidas (/parecidas), el perfil (/perfil), "nos interesa" (/nos-interesa),
// las fundaciones vigiladas (/fundaciones), las empresas (/empresas), las licitaciones públicas (/licitaciones) y /como-sabemos. El servidor sirve index.html para todas; Layout pone el menú lateral.
const ruta = window.location.pathname;
const ficha = /^\/convocatoria\/([^/]+)\/?$/.exec(ruta);

function Pantalla() {
  if (ficha) return <Ficha id={decodeURIComponent(ficha[1])} />;
  if (/^\/parecidas\/?$/.test(ruta)) return <Parecidas />;
  if (/^\/perfil\/?$/.test(ruta)) return <Perfil />;
  if (/^\/nos-interesa\/?$/.test(ruta)) return <NosInteresa />;
  if (/^\/fundaciones\/?$/.test(ruta)) return <Fundaciones />;
  if (/^\/empresas\/?$/.test(ruta)) return <Empresas />;
  if (/^\/licitaciones\/?$/.test(ruta)) return <Licitaciones />;
  if (/^\/como-sabemos\/?$/.test(ruta)) return <ComoSabemos />;
  return <EstaSemana />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Layout><Pantalla /></Layout>
  </StrictMode>,
);
