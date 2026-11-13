import { type FormEvent, useEffect, useState, useSyncExternalStore } from 'react';
import { type EstadoSesion, entrarEquipo, leerSesion, salirEquipo } from './api.ts';

// Estado de sesión compartido por toda la página. Sin TEAM_PASSWORD en el servidor (modoPrivado false) se puede editar todo.
interface Estado extends EstadoSesion { cargada: boolean }
let estado: Estado = { cargada: false, modoPrivado: false, autenticado: false };
const oyentes = new Set<() => void>();
const poner = (e: Estado) => { estado = e; oyentes.forEach((o) => o()); };
let pedida = false;

function cargar() {
  if (pedida) return;
  pedida = true;
  // Si /api/sesion falla, nos quedamos sin controles privados (lo más prudente).
  leerSesion().then((s) => poner({ ...s, cargada: true }), () => poner({ cargada: true, modoPrivado: true, autenticado: false }));
}

export function useSesion() {
  useEffect(cargar, []);
  const e = useSyncExternalStore((o) => { oyentes.add(o); return () => oyentes.delete(o); }, () => estado);
  /** Se pueden ver y usar los controles privados (botones, notas, edición): demo, o equipo con sesión. */
  return { ...e, puedeEditar: e.cargada && (!e.modoPrivado || e.autenticado) };
}

/** Control "Acceso equipo": solo aparece si el servidor está en modo privado. Fijo arriba a la derecha. */
export function AccesoEquipo() {
  const s = useSesion();
  const [abierto, setAbierto] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  if (!s.cargada || !s.modoPrivado) return null;

  const entrar = async (ev: FormEvent) => {
    ev.preventDefault();
    setOcupado(true); setError(null);
    try { poner({ ...(await entrarEquipo(password)), cargada: true }); setPassword(''); setAbierto(false); } catch (e) { setError((e as Error).message); } finally { setOcupado(false); }
  };
  const salir = async () => { try { poner({ ...(await salirEquipo()), cargada: true }); } catch { /* sin red: se queda como está */ } };

  return (
    <div className="mx-auto flex max-w-3xl justify-end px-4 pt-3 text-sm">
      {s.autenticado ? (
        <span className="text-stone-600">Equipo · <button type="button" onClick={() => void salir()} className="text-emerald-800 underline">Salir</button></span>
      ) : abierto ? (
        <form onSubmit={(ev) => void entrar(ev)} className="flex flex-wrap items-center justify-end gap-2">
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Contraseña del equipo" placeholder="Contraseña del equipo" className="rounded border border-stone-300 px-2 py-1" />
          <button type="submit" disabled={ocupado || !password} className="rounded bg-emerald-700 px-3 py-1 text-white disabled:opacity-50">Entrar</button>
          <button type="button" onClick={() => { setAbierto(false); setError(null); }} className="text-stone-500 underline">Cancelar</button>
          {error && <span role="alert" className="w-full text-right text-red-700">{error}</span>}
        </form>
      ) : (
        <button type="button" onClick={() => setAbierto(true)} className="text-emerald-800 underline">Acceso equipo</button>
      )}
    </div>
  );
}
