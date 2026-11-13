import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EstaSemana } from './EstaSemana.tsx';
import { Ficha } from './Ficha.tsx';
import { Parecidas } from './Parecidas.tsx';
import { Perfil } from './Perfil.tsx';
import './index.css';

// Tres pantallas: "Esta semana" (/), la ficha (/convocatoria/<id>) y las organizaciones parecidas (/parecidas). El servidor sirve index.html para ambas.
const ficha = /^\/convocatoria\/([^/]+)\/?$/.exec(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {ficha ? <Ficha id={decodeURIComponent(ficha[1])} /> : /^\/parecidas\/?$/.test(window.location.pathname) ? <Parecidas /> : /^\/perfil\/?$/.test(window.location.pathname) ? <Perfil /> : <EstaSemana />}
  </StrictMode>,
);
