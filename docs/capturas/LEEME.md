# Capturas

Generadas con `npm run build && npm run capturas` (`scripts/capturas.ts`): arranca el servidor en el puerto 8119 contra una copia de `data/radar.sqlite`
(la original no se toca), captura con Chromium de Playwright y lo para. Dos tamaños por pantalla: `-escritorio` (1280×900) y `-movil` (390×844), página completa.

| Fichero (+ `-escritorio.png` / `-movil.png`) | Qué es |
|---|---|
| `esta-semana` | «Esta semana»: frase de resumen, tarjetas de lo que pasa el corte, «El radar vio otras N con menos encaje» y consorcio UE plegados |
| `ficha-cerrada` | Ficha de la convocatoria anual de la CAM (`bdns:904719`): panel de datos con su cita, «Reforesta ganó…», «Cerrada el …» |
| `ficha-abierta` | Ficha de la primera convocatoria abierta y analizada de «Esta semana» |
| `empresas` | Tabla de empresas con una fila desplegada (cita, enlace y notas) |
| `perfil` | Perfil, con el umbral del corte |
| `como-sabemos` | Las pruebas y la sección de límites |

El correo del lunes (`correo.png`) sigue pendiente: `npm run digest -- --vista-previa`. No se fabrican imágenes: se capturan de datos reales.
