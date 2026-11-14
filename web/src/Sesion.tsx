import { type FormEvent, useEffect, useId, useState, useSyncExternalStore } from 'react';
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

/** Control "Acceso equipo": solo aparece si el servidor está en modo privado. Va al pie del menú lateral (fondo oscuro). */
export function AccesoEquipo() {
  const s = useSesion();
  const [abierto, setAbierto] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const idCampo = useId();
  if (!s.cargada || !s.modoPrivado) return null;

  const entrar = async (ev: FormEvent) => {
    ev.preventDefault();
    setOcupado(true); setError(null);
    try { poner({ ...(await entrarEquipo(password)), cargada: true }); setPassword(''); setAbierto(false); } catch (e) { setError((e as Error).message); } finally { setOcupado(false); }
  };
  const salir = async () => { try { poner({ ...(await salirEquipo()), cargada: true }); } catch { /* sin red: se queda como está */ } };
  const enlace = 'rounded text-white underline hover:text-white/80';

  return (
    <div className="text-sm text-white">
      {s.autenticado ? (
        <span>Sesión de equipo · <button type="button" onClick={() => void salir()} className={enlace}>Salir</button></span>
      ) : abierto ? (
        <form onSubmit={(ev) => void entrar(ev)} className="space-y-2">
          <label className="block text-xs text-white/80" htmlFor={idCampo}>Contraseña del equipo</label>
          <input id={idCampo} type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="w-full rounded border border-white/40 bg-white px-2 py-1 text-tinta" />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={ocupado || !password} className="rounded bg-white px-3 py-1 font-medium text-marca-lateral disabled:opacity-50">Entrar</button>
            <button type="button" onClick={() => { setAbierto(false); setError(null); }} className={enlace}>Cancelar</button>
          </div>
          {error && <p role="alert" className="rounded bg-peligro-suave px-2 py-1 text-xs text-peligro">{error}</p>}
        </form>
      ) : (
        <button type="button" onClick={() => setAbierto(true)} className={enlace}>Acceso equipo</button>
      )}
    </div>
  );
}
