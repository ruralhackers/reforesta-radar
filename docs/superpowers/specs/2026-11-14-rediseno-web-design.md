# Rediseño de la web del Radar — diseño

Fecha: 2026-11-14 · Aprobado por Agustín · Maquetas: `.superpowers/brainstorm/` (sesión de visual companion)

## Por qué
La web funciona pero no ayuda a decidir: lista larga de tarjetas iguales, títulos de BDNS en mayúsculas de tres líneas,
lo que decide (importe, días, encaje) en letra pequeña, botones abiertos en cada tarjeta, navegación como línea de texto,
siete botones "Documento" sin nombre. El momento que importa: **alguien de Reforesta el lunes con el café** decide en
segundos qué preparar esta semana. El jurado ve exactamente eso.

## Objetivos / no objetivos
- Corto y decidible: lo que no interesa no compite por la atención (plegado, nunca escondido del todo).
- Misma funcionalidad y privacidad que hoy (decisiones, notas, sesión, `TEAM_PASSWORD`).
- No: cambiar el correo del lunes (se alineará después); librerías de componentes nuevas.

## Enfoque
Rehacer los componentes React existentes con Tailwind + tokens de diseño en CSS custom properties. Descartados:
librería de componentes (dependencias y otro idioma para una web pequeña); rehacer desde cero (se perdería lógica probada).

## Decisiones (elegidas por Agustín sobre maquetas)
- **Navegación: barra lateral.** Esta semana · Nos interesa · Empresas (con contadores) / Ajustes: Perfil, Fundaciones,
  Organizaciones parecidas / Cómo sabemos. Móvil: menú hamburguesa.
- **Esta semana (opción A): resumen + tarjetas cortas.** Frase arriba ("N convocatorias para preparar · M cierran en < 3
  semanas · K empresas nuevas"). Tarjeta: título corto, etiquetas (cierre con días — resaltado si urgente —, importe,
  línea), una frase de por qué encaja, botones Nos interesa / Descartar / Ver ficha. **Corte**: solo analizadas con
  puntuación ≥ umbral (editable en el Perfil), máximo 7; el resto plegado "El radar vio otras N con menos encaje".
  Consorcio UE en su sección plegada aparte.
- **Ficha (opción B): dos columnas.** Izquierda: historial de Reforesta destacado (ganó/no figura), idea de proyecto,
  ganadores anteriores, puntuación desglosada plegada. Derecha, panel fijo: importe, cierre, ¿podemos?, cofinanciación —
  cada uno con su cita —, botones y enlaces con nombre (Bases, Extracto, Sede, nombre real de cada documento). Móvil: el
  panel pasa arriba.
- **Empresas: tabla tipo CRM** priorizada (DIA primero, luego compensan, baja confianza plegada): empresa + origen,
  por qué, dónde, estado en desplegable; fila desplegable con cita, enlace y notas.
- **Fundaciones, Parecidas, Perfil, Cómo sabemos**: mismo estilo, sin cambios funcionales (Perfil gana el umbral del corte).
- **Marca**: colores de Reforesta pedidos, pero reforesta.es no responde ⇒ verde provisional en un único fichero de
  tokens; cabecera "Radar para Reforesta", pie "hecho por Rural Hackers · Common Seeds"; sin su logo.

## Datos nuevos
- El análisis genera un **título corto** (las ya analizadas lo obtienen en la siguiente pasada; mientras, título oficial
  recortado de forma legible — sin mayúsculas sostenidas).
- Documentos con su **nombre real** de BDNS (`descripcion`/`nombreFic`).
- **Umbral del corte** en el perfil.

## Errores a corregir de paso
- "faltan -159 días" en cerradas (mostrar "Cerrada el …").
- Ruido en "cierran pronto" (p. ej. concurso de escaparatismo navideño con 47): investigar por qué pasó criba/puntuación y
  corregir la causa (no a mano por id).
- Convocatorias sin analizar ocupando sitio arriba (el corte lo resuelve).

## A criterio de quien construya
Espaciados, tipografía concreta, iconos, animaciones mínimas, estados vacíos.
