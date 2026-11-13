// Prompts de la criba (Haiku) y del análisis (Sonnet). Todo lo de la organización sale del perfil guardado en la BD:
// aquí no hay nada propio de una entidad concreta. Cambiar un texto aquí invalida la caché de respuestas (va en la clave).
import type { EjemploDecision } from '../db/decisiones.ts';
import type { Convocatoria, Perfil } from '../types.ts';

export interface TextoParaLlm {
  titulo: string;
  texto: string;
}

const MAX_CARACTERES_CRIBA = 12_000;

function describirPerfil(p: Perfil): string {
  return [
    `Organización: ${p.nombre} (entidad sin ánimo de lucro).`,
    'Líneas de trabajo:',
    ...p.lineas.map((l) => `- ${l.nombre}: ${l.descripcion}`),
    `Ámbito: ${p.ambito.descripcion}`,
  ].join('\n');
}

/**
 * Decisiones anteriores del equipo como ejemplos (aprendizaje ligero). Va AL FINAL del texto de sistema, tras todo lo estable
 * (perfil, criterios, reglas), para que cambie lo menos posible. Sin decisiones devuelve [] y el prompt queda idéntico al de antes.
 * Ojo: añadir una decisión cambia el texto de sistema y por tanto la clave de llm_cache (esperado: solo afecta a convocatorias nuevas
 * o aún sin veredicto; los veredictos ya guardados no se rehacen).
 */
export function bloqueEjemplos(ejemplos: EjemploDecision[]): string[] {
  if (ejemplos.length === 0) return [];
  return [
    '',
    'Decisiones anteriores del equipo (de la más reciente a la más antigua). Úsalas solo como orientación sobre lo que le interesa y lo que descarta; no son reglas ni parte de los documentos:',
    ...ejemplos.map((e) => {
      const marca = e.decision === 'nos_interesa' ? 'NOS INTERESÓ' : `DESCARTADA (${e.motivo ?? 'sin motivo'})`;
      return `- ${marca}: ${e.titulo} — ${e.organo}${e.resumen ? ` — ${e.resumen}` : ''}`;
    }),
  ];
}

function bloqueDocumentos(textos: TextoParaLlm[], max: number | null): string {
  return textos.map((t) => {
    const recortado = max !== null && t.texto.length > max;
    const cuerpo = recortado ? `${t.texto.slice(0, max)}\n[… texto recortado para la criba: ${t.texto.length} caracteres en total]` : t.texto;
    return `<documento titulo="${t.titulo.replace(/"/g, "'")}">\n${cuerpo}\n</documento>`;
  }).join('\n\n');
}

/**
 * Convocatorias de la UE (fuente eu_ft): los textos vienen en inglés y la respuesta sigue siendo en castellano.
 * Solo se añade para esas convocatorias, así el prompt de las demás (y su caché) no cambia.
 */
function notaIdioma(c: Convocatoria, citas: boolean): string[] {
  if (c.fuente !== 'eu_ft') return [];
  return [
    '- Los documentos de esta convocatoria de la UE están en inglés. Responde en castellano'
    + (citas ? ' salvo las citas, que se copian literalmente en inglés tal como aparecen (no las traduzcas).' : '.'),
    '  En el portal, "topic" es la convocatoria concreta, "RIA/IA/CSA" son tipos de acción y "LIFE", "Horizon Europe" etc. son programas.',
  ];
}

/**
 * Criterio más estricto para las convocatorias de la UE (fuente eu_ft): son centenares, casi todas de investigación, y "ante la duda" las
 * dejaría pasar todas. Se apoya en las líneas de trabajo del perfil (ya listadas en el prompt), no en nada propio de una organización.
 */
function criterioUe(c: Convocatoria): string[] {
  if (c.fuente !== 'eu_ft') return [];
  return [
    '- CONVOCATORIAS DE LA UE (este criterio prevalece sobre "ante la duda"): decide "puede_encajar" solo si se cumplen las dos cosas:',
    '  (1) el tema CENTRAL de la convocatoria, el que resume su título, es una de las líneas de trabajo de la organización (listadas arriba): actuar sobre',
    '  ecosistemas o hábitats (restaurarlos, conservarlos, controlar invasoras) o educación y sensibilización ambiental. Agricultura, suelo, agua, clima,',
    '  océano, asesoramiento agrario, observación o investigación científica NO bastan por sí solos aunque mencionen la biodiversidad o la restauración;',
    '  (2) una ONG como esta podría participar de forma realista: como coordinadora (p. ej. en LIFE) o como socia de un consorcio en acciones de',
    '  investigación, innovación o coordinación (RIA, IA, CSA) de Horizon Europe. En el motivo di en qué papel (coordinadora o socia de consorcio).',
    '  Descarta si la naturaleza o el medio ambiente son incidentales (patrimonio cultural, valorización de resultados de proyectos, innovación o',
    '  ecosistemas de innovación en general, cohesión social urbana, salud, energía, agricultura o alimentación sin acción sobre ecosistemas),',
    '  si es investigación puramente científica o tecnológica que una ONG no lideraría ni integraría, o si es una acción de gestión del programa.',
  ];
}

function cabecera(c: Convocatoria): string {
  return [
    `Convocatoria ${c.id}: ${c.titulo}`,
    `Órgano: ${[c.organo.nivel1, c.organo.nivel2, c.organo.nivel3].filter(Boolean).join(' · ')}`,
  ].join('\n');
}

// --- Criba (Haiku) ---

export const ESQUEMA_CRIBA: Record<string, unknown> = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['puede_encajar', 'descartar'] },
    motivo: { type: 'string' },
    exigeSedeEnOtraComunidad: { type: 'string', enum: ['si', 'no', 'no_consta', 'no_aplica'] },
  },
  required: ['decision', 'motivo', 'exigeSedeEnOtraComunidad'],
  additionalProperties: false,
};

export function promptCriba(perfil: Perfil, c: Convocatoria, condicion: string | null, textos: TextoParaLlm[], ejemplos: EjemploDecision[] = []): { sistema: string; mensaje: string } {
  const sistema = [
    'Eres la primera criba de un radar de convocatorias de subvenciones para una organización sin ánimo de lucro.',
    'Decides si una convocatoria PUEDE encajar con la organización (para que otra fase la lea a fondo) o si claramente no encaja.',
    '',
    describirPerfil(perfil),
    '',
    'Criterios:',
    '- Descarta solo lo claramente ajeno: ayudas a particulares o familias, a empresas o autónomos sin cabida para entidades sin ánimo de lucro,',
    '  premios o becas individuales, concursos escolares, subvenciones a entidades concretas ya decididas, temas sin relación con las líneas de trabajo.',
    '- Ante la duda, "puede_encajar": la fase siguiente lee las bases completas.',
    '- La elegibilidad se decide por el texto de la convocatoria, no por categorías administrativas.',
    '- "exigeSedeEnOtraComunidad": solo si se te indica una condición de otra comunidad; "si" si el texto exige sede, domicilio,',
    '  delegación o actividad en esa comunidad; "no" si consta que no; "no_consta" si el texto no lo dice; si no hay condición, "no_aplica".',
    '  Si exige sede o actividad allí, la decisión es "descartar".',
    '- El motivo, en castellano, en una frase concreta (qué dice la convocatoria que te lleva a decidir).',
    ...notaIdioma(c, false),
    ...criterioUe(c),
    ...bloqueEjemplos(ejemplos),
  ].join('\n');
  const mensaje = [
    cabecera(c),
    condicion ? `Condición de ámbito: ${condicion}.` : 'Condición de ámbito: ninguna.',
    '',
    bloqueDocumentos(textos, MAX_CARACTERES_CRIBA),
  ].join('\n');
  return { sistema, mensaje };
}

// --- Análisis (Sonnet) ---

/**
 * `ganadores`: ganadores de ediciones anteriores (BDNS) como contexto para la idea de proyecto; null = sin ese contexto
 * y el prompt queda exactamente como antes (así no se invalida la caché de lo ya analizado).
 */
export function promptAnalisis(perfil: Perfil, c: Convocatoria, textos: TextoParaLlm[], ganadores: string | null = null, ejemplos: EjemploDecision[] = []): { sistema: string; mensaje: string } {
  const sistema = [
    'Analizas una convocatoria de subvenciones para una organización sin ánimo de lucro y extraes datos con su cita literal.',
    '',
    describirPerfil(perfil),
    '',
    'Reglas (obligatorias):',
    '- Nunca inventes. Cada campo lleva "cita": un fragmento copiado LITERALMENTE de uno de los documentos (sin parafrasear,',
    '  sin corregir erratas), y "documento": el título exacto del documento donde está. Si no encuentras el dato, valor, cita y documento',
    '  como cadena vacía "" (eso es "desconocido").',
    '  Un campo sin cita se tratará como desconocido.',
    '- elegibilidadEsfl: "si" si las entidades sin ánimo de lucro (asociaciones, fundaciones, ONG, tercer sector) pueden ser beneficiarias;',
    '  "no" si el texto las excluye o limita los beneficiarios a otros tipos. Se decide por el texto de la convocatoria y sus bases,',
    '  no por categorías de metadatos.',
    '- importeMaximoProyecto: cuantía máxima por proyecto o beneficiario. importeTotal: crédito o cuantía total de la convocatoria.',
    '- plazo: el plazo de solicitud tal y como lo dice el texto (literal, sin calcular fechas).',
    '- cofinanciacion: si exige aportación propia o cofinanciación, y cuánta.',
    '- requisitos: los requisitos principales para la entidad solicitante (máximo 6), cada uno con su cita.',
    '- lineas: las líneas de trabajo de la organización con las que encaja, con un motivo breve (y cita si la hay; si no, "").',
    '- ideaProyecto: 3–4 líneas con una idea de proyecto concreta que la organización podría presentar. Sin importes que no estén en los textos.',
    ...(ganadores ? ['  Si se te dan ganadores de ediciones anteriores, úsalos solo como contexto (qué tipo de entidades suelen ganarla); no son parte de los documentos: no los cites ni copies sus importes.'] : []),
    '- En importes, porcentajes y plazos, el valor debe usar las mismas cifras que la cita.',
    '- Escribe en castellano.',
    ...notaIdioma(c, true),
    ...bloqueEjemplos(ejemplos),
  ].join('\n');
  const contexto = ganadores ? ['', 'Contexto (BDNS; no forma parte de los documentos y no es citable). Ganadores de ediciones anteriores:', ganadores] : [];
  const mensaje = [cabecera(c), ...contexto, '', bloqueDocumentos(textos, null)].join('\n');
  return { sistema, mensaje };
}
