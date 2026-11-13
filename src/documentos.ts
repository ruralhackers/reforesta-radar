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

export interface Lectura {
  textos: TextoParaLlm[];
  /** Documentos que no se pudieron leer (se sigue con el resto). */
  errores: string[];
  /** Descargas reales hechas (las de caché no cuentan). */
  descargas: number;
}

export async function extraerTextoPdf(bytes: Uint8Array): Promise<{ texto: string; paginas: number }> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { texto: text, paginas: totalPages };
}

async function descargar(f: typeof fetch, url: string): Promise<{ bytes: Uint8Array; tipoContenido: string }> {
  const res = await f(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error(`demasiado grande (${bytes.byteLength} bytes)`);
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
        if (!texto.trim()) throw new Error('PDF sin texto extraíble (¿escaneado?)');
        guardarTexto(db, hash, texto, paginas, ahora);
      }
    } else if (/html/i.test(tipoContenido) || /^\s*</.test(new TextDecoder().decode(bytes.slice(0, 64)))) {
      tipo = 'html';
      if (!yaLeido) guardarTexto(db, hash, htmlATexto(new TextDecoder().decode(bytes)), null, ahora);
    } else {
      throw new Error(`formato no soportado (${tipoContenido || 'desconocido'})`);
    }
    guardarDocumento(db, url, { hash, tipo, error: null }, ahora);
    return { texto: leerTexto(db, hash)!.texto, descargado: true };
  } catch (e) {
    guardarDocumento(db, url, { hash: null, tipo: null, error: (e as Error).message }, ahora);
    throw e;
  }
}

/** Lee los documentos de una convocatoria: los que traen texto se usan tal cual; los demás se descargan (o se sacan de la caché). */
export async function leerDocumentos(db: DatabaseSync, f: typeof fetch, docs: DocumentoFuente[], ahora: Date): Promise<Lectura> {
  const r: Lectura = { textos: [], errores: [], descargas: 0 };
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
        r.errores.push(`${d.titulo} (${d.url}): ${(e as Error).message}`);
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
