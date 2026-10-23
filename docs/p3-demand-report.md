# P3: demandas y reportes, explicado con ejemplos

## Qué cambió

La ciudad ya registra el intercambio automático que ordena la central y
puede programar el envío de sus cuentas. La primera parte cambia el ledger;
la segunda lo lee y conserva cuándo y qué se intentó enviar.

## 1. Demand-statement: energía y dinero en una sola operación

Reglas del enunciado:

- Energía nueva = energía anterior + quantity.
- Dinero nuevo = dinero anterior - quantity × valuePerKwh.

Partiendo de -20 kWh y 500 créditos:

| Operación | Energía | Dinero |
| --- | ---: | ---: |
| Estado inicial | -20 | 500 |
| quantity=30, valuePerKwh=2 | 10 | 440 |
| quantity=-5, valuePerKwh=3 | 5 | 455 |
| Reenvío de la última operación, mismo idpk | 5 | 455 |

No hay que esperar ni emitir un transfer adicional: cobrar otra vez sería
contar dos veces el intercambio. Se permiten saldos negativos. Una demanda
que llega antes del estado inicial queda guardada y se refleja cuando llega
ese estado. Refrescar el estado no borra los intercambios previos del ciclo.

La migración 002 modifica la vista contable; no actualiza operaciones antiguas.
Los valores se calculan con numeric de Postgres. El esquema de migraciones
recuerda cuáles se ejecutaron para no reinstalar una vista antigua al reiniciar.

## 2. Negotiation-report: avisar cómo están las cuentas

Al recibir un status-statement, el backend crea un trabajo en `report_jobs`:

- Un solo idpk para el reporte del ciclo.
- Cierre tomado de `data.validUntil`.
- Primera hora de envío: cierre menos cinco minutos.

Ejemplo: validUntil=14:20 → envío programado a las 14:15. Esa es la traducción
del enunciado, que pide reportar en los últimos cinco minutos. Si la central
corrige la apertura mediante opensAt, su fecha tiene prioridad.

Al llegar la hora se toma el balance de energía del ciclo y el presupuesto
GLOBAL más reciente. No se usa la observación histórica del presupuesto que
muestra `/ledger` si hubo movimientos posteriores de otro ciclo.

Se guarda un intento antes de llamar al connector. Esto incluye el mensaje,
msgId, hora prevista, hora de inicio y secuencia de ledger usada para calcular
los saldos. Después, el connector publica en energy.x con routing key central
y userId city.REE, esperando la confirmación de RabbitMQ.

La ruta `GET /cycles/:cycleId/report` permite ver el trabajo y todos sus
intentos. `report_attempts` es la evidencia de los reportes; no se insertan
como falsas operaciones contables. El frontend y los resúmenes existentes de
P4 todavía no incorporan esta nueva ruta de reportes.

## 3. Qué ocurre si la central dice REPORT_TOO_EARLY

Ejemplo de respuesta:

```json
{
  "type": "error",
  "reason": "REPORT_TOO_EARLY",
  "cycleId": "cycle-example",
  "data": {
    "target": "msgId-del-intento",
    "opensAt": "2030-01-01T14:16:12.137Z",
    "message": "Report window is not open"
  }
}
```

El backend encuentra el intento por target, persiste opensAt como próxima
hora y arma un temporizador hasta ese instante. No agrega cinco segundos ni
un backoff. Si reinicia antes, lee la fecha de Postgres y vuelve a programar.
Si reinicia después de opensAt pero antes del cierre, intenta cuanto antes.

El objetivo temporal es exactamente opensAt; ejecución del proceso, consultas
y red pueden retrasar el envío real. Esto no es un sistema de tiempo real duro.
La consulta muestra `scheduled_at`, `started_at` y `published_at` para medirlo.

Cada reintento conserva idpk y tiene un msgId nuevo. Un rechazo explícito por
ser temprano permite recalcular el snapshot para la nueva hora. En cambio,
si se pierde la respuesta HTTP y no sabemos si fue publicado, se conserva el
snapshot previo: se está reintentando el mismo reporte, no otro saldo.

Máximo cuatro intentos: el original y tres reintentos. Un timeout o falta de
ACK deja el siguiente intento a 30 segundos (decisión del scheduler); no se
reintenta después del cierre. opensAt fuera de la ventana o inválido, un NACK
o un error distinto dejan el trabajo fallido. No hay bucles infinitos.

## 4. ACK no significa aceptación final

La central puede responder ACK y luego REPORT_TOO_EARLY. El ACK cambia el
estado a `acknowledged`, pero ese error aún puede reprogramar el trabajo.
Nunca se muestra un ACK como prueba definitiva de aceptación del saldo.

Los estados son:

| Estado | Significado |
| --- | --- |
| pending | Espera su fecha o un reintento. |
| sending | Intento persistido; publicación en curso o interrumpida. |
| sent | Connector confirmó publicación; esperamos respuesta de la central. |
| acknowledged | Central confirmó recepción; un error posterior aún puede llegar. |
| expired | La ventana cerró. |
| failed | Rechazo no recuperable o límite de intentos agotado. |
| blocked | Las cuentas aún no permiten preparar un reporte válido. |

Una respuesta vieja de otro intento no pisa el intento actual. Una respuesta
puede llegar incluso antes de terminar el POST al connector: los IDs ya están
persistidos para reconocerla. Los errores de transporte se distinguen de los
errores de la central en el historial de intentos.

## 5. Reinicios y concurrencia

El pending y su snapshot viven en Postgres, no solo en memoria. Un intento
interrumpido se recupera cuando vence su espera de 30 segundos. Los workers
usan el mismo bloqueo transaccional que el ledger para que dos réplicas no
creen el mismo intento simultáneamente y para leer cuentas coherentes.

El worker despierta al recibir mensajes y reconcilia cada segundo. Dentro del
siguiente segundo usa la fecha exacta del trabajo, sin redondearla al próximo
tick. El HTTP al connector tiene timeout de diez segundos.

## 6. Activación y límites actuales

Por defecto `REPORTS_ENABLED=false`: se guardan trabajos y respuestas, pero
no se publican reportes. Esto permite revisar el cambio sin activar envíos.
Para habilitar se requiere además `LEDGER_BASELINE_CONFIRMED=true` después de
reconciliar el saldo inicial. La bandera no modifica dinero ni importa historia.

Las negociaciones voluntarias aún no están contabilizadas. Si hay registros
`negotiation-proposal`, `give` o `take` en el historial, se bloquea el reporte
antes de preparar su snapshot. El control es global porque el dinero se
arrastra entre ciclos. No borrar ese historial para esquivar el bloqueo: el
siguiente trabajo P3 debe integrar esas operaciones y adaptar esta condición.

No es todavía una certificación de RF03 completo ni de funcionamiento en la
central real. No se desplegó, no se activaron flags en AWS y no se enviaron
mensajes al broker del curso.

## 7. Cómo comprobarlo y explicarlo

Con una base de pruebas, desde master:

```sh
TEST_DATABASE_URL=postgresql://usuario:clave@localhost:5432/energyshark_test npm test
```

La suite requiere esa URL explícita; cada archivo crea y elimina su propio
esquema aleatorio. No usar una base de producción. Las pruebas importantes:

1. Aplicar ambas demandas del ejemplo y verificar energía/dinero.
2. Duplicar una demanda y comprobar que los saldos no cambian otra vez.
3. Antes de la apertura, comprobar cero publicaciones; en la apertura, una.
4. Responder ACK y REPORT_TOO_EARLY mientras sigue abierto el HTTP de publicación.
5. Comprobar due_at=opensAt y que no envía un milisegundo antes con reloj controlado.
6. Reiniciar el backend antes de opensAt y comprobar que recupera el intento.
7. Simular pérdida de respuesta HTTP y verificar mismo idpk y snapshot.
8. Verificar tope de intentos y que la ventana cerrada detiene publicaciones.

Postgres y el backend HTTP son reales; la central y el canal AMQP se simulan.
La prueba integrada envía el reporte al HTTP de un connector simulado y
responde por `POST /events`, como lo haría el connector real. La publicación
AMQP se prueba aparte para verificar envelope, exchange, routing key y userId.

Explicación breve para un compañero:

> Las demandas actualizan energía y dinero juntas, una sola vez por operación.
> El reporte toma esas cuentas y programa su envío en la ventana del ciclo.
> Guardamos el trabajo antes de enviarlo para poder recuperarnos de reinicios.
> Si la central dice que fue temprano, usamos su opensAt y reintentamos la misma
> operación con un mensaje nuevo. Todo queda registrado para revisar qué pasó.
