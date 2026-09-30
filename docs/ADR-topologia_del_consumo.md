# ADR 0001 — Topología del consumo del broker

## Contexto

Nuestro nodo representa a la ciudad REE (Re-Estize). Consume la cola
`city.REE.q` del broker RabbitMQ del curso y debe aplicar cada mensaje
recibido sobre el ledger local, además de publicar respuestas (ACK, NACK,
reportes y propuestas) en el exchange `energy.x`.

Tres restricciones acotan la decisión:

1. El ciclo de negociación es autónomo y tiene ventanas con plazos duros
   (el `negotiation-report` debe salir dentro de la ventana de cierre). Un
   servicio caído durante una ventana cuesta puntos y multas.
2. No podemos declarar ni modificar colas: la topología es del servidor.
3. Venimos de la Entrega 0 con un consumidor y una API ya operativos en
   EC2, separados en dos contenedores.

## Alternativas consideradas

### A. Un solo proceso Node

La API HTTP y el consumidor AMQP viven en el mismo servicio.

- **A favor:** menos infraestructura, sin salto de red, una sola imagen que
  desplegar, transacciones directas contra la base de datos.
- **En contra:** una excepción no capturada procesando un mensaje mata el
  proceso completo y con él la API. Eso viola directamente la propiedad
  exigida. Además el trabajo de consumo compite por el mismo event loop que
  atiende las requests HTTP, y Node es de un solo hilo.

### B. Dos procesos; el consumidor le habla a la API por HTTP

El consumidor recibe del broker, hace `POST` a la API, y solo hace `ack` al
broker cuando la API confirmó que persistió. Si la API no responde, reencola
con espera.

- **A favor:** aísla los fallos — el consumidor puede morir y reiniciarse sin
  tocar la API, y viceversa. El orden "persistir primero, `ack` después"
  garantiza que ningún mensaje se pierda: si el proceso muere entremedio, el
  mensaje sigue en la cola y se reprocesa. La lógica del ledger vive en un
  solo lugar.
- **En contra:** un salto de red adicional por mensaje, y un contrato interno
  entre consumidor y API que hay que mantener versionado.

## Decisión

Adoptamos **B**.

Es la única de las dos en que el `ack` al broker ocurre después de la
escritura, que es literalmente la propiedad que el enunciado exige. Además es
la topología que ya veníamos operando desde la Entrega 0, así que la decisión está validada
por operación real y no solo por diseño.

Descartamos A porque no cumple la propiedad.

Concretamente:

- El consumidor abre la conexión AMQPS y reintenta cada 5 segundos ante
  `error` o `close`, sin intervención manual.
- `prefetch(1)`: se procesa un mensaje a la vez.
- Un mensaje que no parsea se descarta con `nack(msg, false, false)` — sin
  reencolar, para no entrar en un ciclo infinito con un mensaje corrupto — y
  queda registrado (RF05).
- Un mensaje válido se envía a la API; con respuesta OK se hace `ack`, y sin
  ella se espera y se reencola con `nack(msg, false, true)`.
- El consumidor escribe un heartbeat en disco cada 15 segundos; el
  `HEALTHCHECK` del contenedor lo lee y marca *unhealthy* si queda viejo.

## Consecuencias

- Si la API está caída, el consumidor reencola con espera: no se pierde nada,
  pero la cola crece. Hay que vigilar su largo durante la demo.
- Los reintentos necesitan un tope. Reencolar sin límite ante una API
  permanentemente caída se parece a un loop de mensajería, y el curso aplica
  ban escalonado del broker ante eso.
- El aislamiento nos da gratis dos de las anomalías de la demo: el corte del
  broker (reconexión sola) y la caída de un contenedor (`restart:
  unless-stopped` más healthcheck).