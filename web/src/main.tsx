import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EstaSemana } from './EstaSemana.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <EstaSemana />
  </StrictMode>,
);
