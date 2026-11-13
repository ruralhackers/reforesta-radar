import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EstaSemana } from './EstaSemana.tsx';
import { Ficha } from './Ficha.tsx';
import { NosInteresa } from './NosInteresa.tsx';
import { Parecidas } from './Parecidas.tsx';
import { Perfil } from './Perfil.tsx';
import { AccesoEquipo } from './Sesion.tsx';
import './index.css';

// Pantallas: "Esta semana" (/), la ficha (/convocatoria/<id>) las organizaciones parecidas (/parecidas), el perfil (/perfil) y "nos interesa" (/nos-interesa). El servidor sirve index.html para ambas.
const ficha = /^\/convocatoria\/([^/]+)\/?$/.exec(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AccesoEquipo />
    {ficha ? <Ficha id={decodeURIComponent(ficha[1])} /> : /^\/parecidas\/?$/.test(window.location.pathname) ? <Parecidas /> : /^\/perfil\/?$/.test(window.location.pathname) ? <Perfil /> : /^\/nos-interesa\/?$/.test(window.location.pathname) ? <NosInteresa /> : <EstaSemana />}
  </StrictMode>,
);
