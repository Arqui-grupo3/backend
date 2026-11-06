# AI log — P2 — Anomalías 3 y 5 de la demo, corrección del comprador y deploy fallido

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Claude Code (Claude Opus 5.5), con acceso a los repos locales, Docker, GitHub CLI y el navegador.
- Fuente: conversación «Trabajo de Arquitectura de Sistemas de Software (E2)».
- Registro retrospectivo: prompts conservados; respuestas y salidas resumidas.

## Prompts relevantes

> haz un git pull, y luego puedes revisar la anomalia

> Fallo el deploy, para que me asistas con la razon.

> Ayudame a armar mis AI logs siguiendo el formato que teniamos en la entrega anterior

## Anomalías revisadas

El texto exacto de las anomalías se leyó del enunciado en Notion.

- **Anomalía 3 (contraparte que no cumple).**
  - Como vendedor el nodo se recupera: el swap vence a los 45 s y `swap-expired` libera la cantidad y publica `offer-updated`. Falta un respaldo por temporizador si ese evento no llega.
  - Como comprador había un problema: un bid en `sent` sin `bid-accepted` válido seguía comprometido hasta `closesAt`, así que el nodo no podía ofertar a otro vendedor dentro de la ventana.
- **Anomalía 5 (corte del broker).** La reconexión es automática y el `ack` va después de persistir. Riesgos señalados, sin corregir: los mensajes salientes que fallan durante el corte no se reintentan, un fallo a mitad de la reconexión deja una promesa sin manejar (Docker reinicia el proceso) y se ignora en silencio `EADDRINUSE` del puerto interno.

## Corrección del comprador

1. Un bid en `sent` se libera a los 40 s desde el primer intento (`BUYER_BID_RESPONSE_TIMEOUT_S`), salvo que tenga una respuesta pendiente de procesar. El worker pasa a la siguiente oferta.
2. El integrante propuso además marcar como rechazado un `bid-accepted` con token inválido. Al leer los tests existentes se descartó: un test exige a propósito que un token falso no anule el bid, para que un tercero no pueda sabotearlo. El plazo cubre ese caso.
3. Un test nuevo falló porque la oferta alternativa del fixture superaba el techo de precio con su transporte; se ajustó el test bajando su precio, como hace otro test existente.
4. Un test de integración de `ledger.test.js` falló una vez al correr la suite completa. Se comprobó que pasa solo, con y sin el cambio, y que no volvió a fallar en una segunda corrida completa.

## Deploy fallido

1. El deploy de #52 a `main` falló en «Verificar que la API responde»: 20 intentos con 502.
2. La salida del paso de despliegue mostró el contenedor `master` reiniciándose. Comparando los `require` de `index.js` con el Dockerfile, faltaban `admin/`, `cycles/` y `reconciliation/` (agregados en #47). Se confirmó construyendo la imagen de `main`: esos módulos no se resolvían.

## Resultado

- Corrección del comprador: PR #53, mergeado.
- Arreglo del Dockerfile: rama subida, pendiente de PR y revisión.
- Producción con `master` caído desde las 21:02 UTC del 6-11 hasta que se despliegue el arreglo.

Este registro es histórico.
