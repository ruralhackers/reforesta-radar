// Lectura de documentos para el análisis: descarga (PDF o HTML) → texto, con caché en la BD.
// - url → hash del contenido: un documento ya descargado no se vuelve a pedir.
// - hash → texto: un PDF ya leído no se vuelve a extraer (aunque llegue por otra url).
// La caché de respuestas del LLM (por hash de la petición) hace que los mismos textos no se vuelvan a enviar.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { extractText, getDocumentProxy } from 'unpdf';
import { guardarDocumento, guardarTexto, leerDocumento, leerTexto } from './db/repo.ts';
import type { TextoParaLlm } from './llm/prompts.ts';
import type { DocumentoFuente } from './sources/source.ts';
import { htmlATexto } from './texto.ts';

const USER_AGENT = 'Mozilla/5.0 (compatible; radar-convocatorias/0.1)';
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 25 * 1024 * 1024;
/** Unos 100k tokens por documento; lo que pase se recorta y se dice en el propio texto. */
export const MAX_CARACTERES_DOCUMENTO = 400_000;
/** Fallos pasajeros seguidos (en ejecuciones distintas) tras los que un documento se da por ilegible. */
export const MAX_FALLOS_PASAJEROS = 3;

/**
 * Fallo al leer un documento. `transitorio` (red, tiempo agotado, 429/5xx): puede salir bien más tarde, así que el
 * análisis no debe darse por terminado sin él. Si no (formato no soportado, PDF sin texto, 404…), es definitivo.
 */
export class ErrorDocumento extends Error {
  transitorio: boolean;
  constructor(mensaje: string, transitorio: boolean) {
    super(mensaje);
    this.transitorio = transitorio;
  }
}

export interface Lectura {
  textos: TextoParaLlm[];
  /** Documentos que no se pudieron leer de forma definitiva (se analiza con el resto). */
  errores: string[];
  /** Documentos que fallaron por algo pasajero: con alguno, el análisis se aplaza (sin llamar al LLM). */
  erroresTransitorios: string[];
  /** Descargas reales hechas (las de caché no cuentan). */
  descargas: number;
}

export async function extraerTextoPdf(bytes: Uint8Array): Promise<{ texto: string; paginas: number }> {
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 }); // sin "Warning: TT: …" de pdf.js en stderr
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { texto: text, paginas: totalPages };
}

async function descargar(f: typeof fetch, url: string): Promise<{ bytes: Uint8Array; tipoContenido: string }> {
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await f(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new ErrorDocumento(`HTTP ${res.status}`, res.status === 408 || res.status === 429 || res.status >= 500);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (e instanceof ErrorDocumento) throw e;
    throw new ErrorDocumento((e as Error).message, true); // red, DNS, tiempo agotado
  }
  if (bytes.byteLength > MAX_BYTES) throw new ErrorDocumento(`demasiado grande (${bytes.byteLength} bytes)`, false);
  return { bytes, tipoContenido: res.headers.get('content-type') ?? '' };
}

const esPdf = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF

async function textoDeUrl(db: DatabaseSync, f: typeof fetch, url: string, ahora: Date): Promise<{ texto: string; descargado: boolean }> {
  const cacheado = leerDocumento(db, url);
  if (cacheado?.hash) {
    const t = leerTexto(db, cacheado.hash);
    if (t) return { texto: t.texto, descargado: false };
  }
  try {
    const { bytes, tipoContenido } = await descargar(f, url);
    const hash = createHash('sha256').update(bytes).digest('hex');
    let tipo: string;
    const yaLeido = leerTexto(db, hash);
    if (esPdf(bytes)) {
      tipo = 'pdf';
      if (!yaLeido) {
        const { texto, paginas } = await extraerTextoPdf(bytes);
        if (!texto.trim()) throw new ErrorDocumento('PDF sin texto extraíble (¿escaneado?)', false);
        guardarTexto(db, hash, texto, paginas, ahora);
      }
    } else if (/html/i.test(tipoContenido) || /^\s*</.test(new TextDecoder().decode(bytes.slice(0, 64)))) {
      tipo = 'html';
      if (!yaLeido) guardarTexto(db, hash, htmlATexto(new TextDecoder().decode(bytes)), null, ahora);
    } else {
      throw new ErrorDocumento(`formato no soportado (${tipoContenido || 'desconocido'})`, false);
    }
    guardarDocumento(db, url, { hash, tipo, error: null, fallos: 0 }, ahora);
    return { texto: leerTexto(db, hash)!.texto, descargado: true };
  } catch (e) {
    const pasajero = e instanceof ErrorDocumento && e.transitorio;
    const fallos = pasajero ? (cacheado?.fallos ?? 0) + 1 : 0;
    guardarDocumento(db, url, { hash: null, tipo: null, error: (e as Error).message, fallos }, ahora);
    // Un servidor que nunca responde (dominio caído) no puede aplazar el análisis para siempre.
    if (pasajero && fallos >= MAX_FALLOS_PASAJEROS) {
      throw new ErrorDocumento(`${(e as Error).message} (sin respuesta en ${fallos} intentos)`, false);
    }
    throw e;
  }
}

/** Lee los documentos de una convocatoria: los que traen texto se usan tal cual; los demás se descargan (o se sacan de la caché). */
export async function leerDocumentos(db: DatabaseSync, f: typeof fetch, docs: DocumentoFuente[], ahora: Date): Promise<Lectura> {
  const r: Lectura = { textos: [], errores: [], erroresTransitorios: [], descargas: 0 };
  for (const d of docs) {
    let texto: string;
    if (d.texto !== undefined) {
      texto = d.texto;
    } else if (d.url) {
      try {
        const t = await textoDeUrl(db, f, d.url, ahora);
        texto = t.texto;
        if (t.descargado) r.descargas++;
      } catch (e) {
        const mensaje = `${d.titulo} (${d.url}): ${(e as Error).message}`;
        // Un PDF que unpdf no puede abrir (corrupto) también es definitivo: solo lo de red es pasajero.
        if (e instanceof ErrorDocumento && e.transitorio) r.erroresTransitorios.push(mensaje);
        else r.errores.push(mensaje);
        continue;
      }
    } else continue;
    if (texto.length > MAX_CARACTERES_DOCUMENTO) {
      texto = `${texto.slice(0, MAX_CARACTERES_DOCUMENTO)}\n[… documento recortado: ${texto.length} caracteres en total]`;
    }
    if (texto.trim()) r.textos.push({ titulo: d.titulo, texto });
  }
  return r;
}
