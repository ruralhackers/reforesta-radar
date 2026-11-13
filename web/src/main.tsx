import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EstaSemana } from './EstaSemana.tsx';
import { Ficha } from './Ficha.tsx';
import './index.css';

// Dos pantallas: "Esta semana" (/) y la ficha (/convocatoria/<id>). El servidor sirve index.html para ambas.
const ficha = /^\/convocatoria\/([^/]+)\/?$/.exec(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {ficha ? <Ficha id={decodeURIComponent(ficha[1])} /> : <EstaSemana />}
  </StrictMode>,
);
