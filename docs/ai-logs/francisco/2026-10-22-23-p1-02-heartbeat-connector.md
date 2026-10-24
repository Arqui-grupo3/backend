# AI log — P1 — Heartbeat del connector

- Integrante: P1 (Francisco), equipo EnergyShark, ciudad REE.
- Herramienta: Claude.
- Periodo: 22–23 de octubre de 2026; zona America/Santiago.
- Fuente: conversación en la aplicación de Claude.
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> corregir el heartbeat del connector (hoy nunca se escribe), restart: always

> dime paso a paso que cambiaste

## Contexto aportado

El post-mortem de AD1 mostró que `healthcheck.js` leía un archivo de heartbeat que `index.js` nunca escribía, por lo que el connector aparecía `unhealthy` aunque consumía bien. El usuario también pegó en la conversación tres salidas de terminal al probar en local: Docker no disponible en WSL, falta de `connector/.env` y un conflicto con un contenedor `master` de otra copia del proyecto.

## Trabajo asistido

1. Cambios en `connector/index.js`: escribir el heartbeat cada 15 s solo mientras el connector consume la cola; marcar la caída en los handlers de conexión y de canal (los del canal no existían); `await` en `channel.consume`.
2. Watchdog: si el connector pasa 2 minutos sin consumir, termina con código 1. Docker no reinicia un contenedor por estar `unhealthy`, solo cuando el proceso termina.
3. `restart: always` en los tres servicios de `docker-compose.yml` y `docker-compose.prod.yml`.
4. Prueba del watchdog en una copia aparte, contra un broker inexistente: el proceso terminó con código 1 en el tiempo esperado.
5. Guía paso a paso para aplicar los cambios a mano en el repositorio oficial.
6. Diagnóstico de los errores locales: integración de Docker Desktop con WSL, creación de `connector/.env` y eliminación del contenedor antiguo.
7. Prueba local con un RabbitMQ propio, con la cola `city.REE.q` creada a mano, en vez del broker del curso.

## Revisión y decisiones del usuario

- Pidió que se le explicara cada cambio paso a paso antes de aplicarlo.
- Se descartó usar las credenciales reales de REE en local: el connector local habría consumido la misma cola que el de producción y se habría quedado con mensajes de la central.
- Se agregó al commit solo los tres archivos modificados, dejando fuera los cambios de fin de línea (CRLF) de la copia de Windows.

## Resultado y límites

En local, `docker ps` mostró el connector como `healthy` consumiendo del RabbitMQ local. La prueba del watchdog con el RabbitMQ detenido y la verificación en la EC2 quedaron pendientes del deploy. Queda propuesto agregar un healthcheck a `master` y corregir el mensaje del log del connector, que siempre muestra el host por defecto aunque `RABBIT_URL` apunte a otro.
