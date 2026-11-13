// Tipos de las respuestas de /api (espejo de src/api/app.ts).
export interface ConvocatoriaSemana {
  id: string;
  fuente: string;
  titulo: string;
  organo: string;
  fechaPublicacion: string;
  url: string;
}

export interface Ejecucion {
  id: number;
  inicio: string;
  fin: string | null;
  estado: string;
  fuentes: { fuente: string; recibidas: number; candidatas: number; descartadas: number; errores: string[] }[];
}

export interface Semana {
  desde: string;
  hasta: string;
  convocatorias: ConvocatoriaSemana[];
  ultimaEjecucion: Ejecucion | null;
}

export async function leerSemana(): Promise<Semana> {
  const res = await fetch('/api/semana');
  if (!res.ok) throw new Error(`Error ${res.status}`);
  return res.json() as Promise<Semana>;
}
