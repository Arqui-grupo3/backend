# AI log — P2 — Envelope v2, publicador y validaciones

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Codex.
- Periodo: 6–7 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «Revisar avances del proyecto P2».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> Creemos el publicador comun entonces

> conectemos el publisher entonces

> Vamos con la exigencia de sender: 'central' en la recepcion, para identificar las centrales

> Que falta para finalizar Envelope v2 y NACK

> Que tal sobre este paso ☐ **P2** No declarar la cola: si la librería hace assertQueue, el servidor cierra el canal por permisos, luego de contarme, continuemos con transfer

> Muestrame todas las regulaciones de tipos de datos que hiciste

## Trabajo asistido

1. Creación de connector/publisher.js como publicador común con canal de confirmación AMQP.
2. Construcción del envelope saliente con idpk y msgId distintos, timestamp ISO, cityId REE, type y data; campos adicionales cuando corresponde.
3. Publicación en energy.x hacia central, con userId AMQP city.REE. Esta identidad pertenece a las propiedades del protocolo, no al JSON.
4. Conexión del publicador al consumidor para producir ACK y NACK del protocolo.
5. Validación del envelope recibido y exigencia de sender igual a central.
6. Validación del contenido por tipo, respetando las convenciones de signos de transfer y demand-statement.
7. Revisión del consumo sin assertQueue ni declaraciones de exchanges o bindings, porque la topología pertenece al servidor.

## Reglas documentadas

| Elemento | Regla tratada |
| --- | --- |
| msgId / idpk | UUID y valores distintos. |
| timestamp | ISO 8601, con fecha y zona válidas. |
| data | Objeto JSON. |
| sender recibido | central. |
| transfer.quantity | Número finito; admite valores positivos, negativos y cero. |
| Capacidades, costos, balances y distancias | Tipos y signos según cada campo del contrato. |
| give / take | target UUID, energía positiva y precio no negativo. |
| ACK | data.target correlaciona el msgId recibido. |
| NACK / error | reason, code, target y campos específicos coherentes. |

## Flujo y decisiones

- Un mensaje válido se envía al master. Después de su respuesta exitosa se publica el ACK aplicable y se confirma la entrega al broker.
- Un mensaje inválido con msgId utilizable genera NACK cuando corresponde. Los tipos ack/nack/error no reciben otra respuesta de protocolo para evitar bucles.
- Los fallos de HTTP o publicación provocan reencolado.
- Se distinguieron ACK/NACK de aplicación de ack/nack de la entrega AMQP.
- La presencia de sender: central identifica el envelope conforme al contrato; por sí sola no constituye una prueba criptográfica de identidad.

## Resultado y límites

Se implementaron validadores de envelope y contenido para los doce tipos tratados en la entrega. La verificación local del formato no sustituye controles de negocio como existencia y vencimiento de ciclos, capacidad, precio máximo o liquidación de negociaciones.

Al cierre del historial registrado se había demostrado una petición válida y respuesta de la central. Seguía pendiente la prueba real de un rechazo NACK.
