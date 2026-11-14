# Guion del vídeo (≈2:40)

Para la entrega del reto 1hack A Coruña. Grabación de pantalla de la web real, **sin voz**: solo subtítulos incrustados (≈17 caracteres/s, mínimo 2,5 s cada uno).
Este documento es la fuente de los subtítulos: `scripts/video/grabar.ts` (`npm run video`) lleva el mismo texto y genera `video/radar-reforesta-demo.mp4`, el `.srt` y un fotograma por escena en `video/frames/`.

Solo hay lo que se ve en pantalla hoy: dos convocatorias para preparar (El Boalo y Fundación Endesa), barra lateral, fichas a dos columnas y la tabla de Empresas. La convocatoria de Usera ya no aparece en «Esta semana»: se muestra solo como ejemplo de lo que el radar descarta (exige sede en Usera).

Preparar antes: instancia en marcha (por defecto `http://localhost:8116`, variable `RADAR_URL`), `npm run build`, y `RADAR_URL_PUBLICA=https://reforesta.ruralhackers.com npm run digest -- --vista-previa` para regenerar `data/digest-preview.html`.

## 1. Título y problema (tarjeta)

Tarjeta: «Radar para Reforesta», 6–7 personas, 4–5 solicitudes al año, ~90 % de financiación privada, empresas (RSC) a cero.

- Reforesta son 6 o 7 personas y presentan 4 o 5 solicitudes al año.
- Cerca del 90 % de su financiación es privada, y la de empresas (RSC) está a cero.
- Radar para Reforesta busca por ellos: convocatorias y empresas, con su porqué.

## 2. Esta semana (`/`)

- Esta semana: 2 convocatorias para preparar. 1 cierra en menos de 3 semanas.
- El Boalo: un ayuntamiento que financia sensibilización ambiental. 21.500 € en total; cierra el 30 de noviembre.
- Fundación Endesa: hasta 45.000 euros por proyecto para restauración de ecosistemas.
- Aparte queda 1 con menos encaje: el radar no esconde lo que ha visto.
- Y 8 convocatorias de la UE, solo para entrar como socio de un consorcio.

## 3. Ficha de El Boalo

- La ficha de El Boalo. Cada dato lleva su cita literal del documento.
- ¿Podemos pedirla? Sí: admite entidades sin ánimo de lucro, con la cita que lo dice.
- Lo que no consta, como la cofinanciación, se marca como desconocido: nunca se inventa.
- Y propone una idea de proyecto: sensibilización ambiental en El Boalo, Cerceda y Mataelpino.

## 4. Ficha CAM 2026 (cerrada, con historial)

- Hasta 30.000 euros por proyecto, con la cita literal de las bases.
- Está cerrada desde el 8 de junio de 2026, y la ficha lo dice.
- Reforesta la ganó en 2025 con 29.378,15 €, en 2024 con 29.076,85 € y en 2022 con 50.532,31 €.
- Así la encontró el radar: otras 22 organizaciones parecidas ganaron una edición anterior.

## 5. Descartada: Usera

- También enseña lo que descarta. Esta ayuda de Usera parece buena: hasta 5.000 euros.
- ¿Podemos pedirla? No: exige sede social en Usera, y la entidad está en Tres Cantos.
- Descartada en el análisis, con la cita literal que lo demuestra.

## 6. Empresas (CRM)

- Empresas: primero las que una declaración de impacto ambiental del BOE obliga a restaurar o compensar.
- Seis, como Red Eléctrica, BRUC Las Quinientas o Sistemas Energéticos Barandón.
- Al abrir una fila aparece la cita del BOE que lo dice.
- Después, 192 empresas que ya compensan su huella de carbono en el registro del MITECO.

## 7. Cómo sabemos (`/como-sabemos`)

- De 6 convocatorias conocidas, el radar habría detectado las 6.
- Y de 25 que ganaron organizaciones parecidas, 23 pasan la criba (92 %).
- Con una advertencia en la propia página: son pocas, y no es una precisión.

## 8. Correo del lunes (vista previa)

- Cada lunes, un correo corto: las destacadas de la semana, con su porqué y su cierre.
- Y las empresas nuevas más claras, cada una con su enlace al BOE.

## 9. Cierre (tarjeta)

Tarjeta: repositorio https://github.com/ruralhackers/reforesta-radar, demo https://reforesta.ruralhackers.com, «Hecho por Rural Hackers para Common Seeds · 1hack A Coruña». Sin subtítulos (6,5 s).


## Notas

- Cifras de `/como-sabemos`: 6 de 6 detectadas; 23 de 25 (92 %) pasan la criba. Con la advertencia de la propia página (pocas convocatorias; no es una precisión).
- El chip de El Boalo muestra «21.500,00 € en total» porque el análisis no extrajo importe por proyecto («No consta en los textos»); el «límite de 1.500 euros» solo aparece en el motivo de la línea. Por eso el vídeo dice «21.500 € en total» y no cita 1.500 €.
- La edición 2026 de la CAM (BDNS 904719) está cerrada (8 jun 2026): se dice así. No se afirma que Reforesta perdiera ninguna convocatoria.
- Mostrar solo datos públicos; no hay notas internas en las fichas grabadas.
