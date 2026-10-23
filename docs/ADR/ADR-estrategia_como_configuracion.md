# ADR 0006 — Estrategia como configuración (AD6)

## Contexto

En la E2 la estrategia de mercado (precio y cantidad de la oferta, política de aceptación de bids, span de compra y política de selección de ofertas) va a cambiar muchas veces: para competir en el leaderboard, para el experimento de span (RF06) y en vivo durante la demo. Cada cambio tiene que aplicar sin redeploy ni reinicio, y cada ciclo tiene que quedar atribuido a la estrategia que usó, porque RF06 compara resultados por valor de span.

En la E1 todo lo que vivía solo en memoria o solo en el código nos falló (post-mortems de AD1 y AD3): lo que funcionó fue el estado durable en Postgres y el log append-only (post-mortem de AD2).

| Parte | Valor |
| --- | --- |
| Fuente | El grupo, durante la demo |
| Estímulo | Cambiar el span, la política de aceptación o el precio de la oferta a mitad de un ciclo |
| Ambiente | Nodo en producción |
| Artefacto | La separación entre la política de mercado y el mecanismo que la ejecuta |
| Respuesta | El cambio aplica en el siguiente ciclo sin redeploy ni reinicio, y queda registrado qué estrategia corrió en cada ciclo |
| Medida | El experimento de RF06 se corre cambiando configuración, y la vista de RF06 atribuye cada ciclo al span que efectivamente usó |

## Alternativas consideradas

### A. Variables de entorno

- **A favor:** ya es como configuramos todo en la E1 (`REPORTS_ENABLED`, `AUTH_REQUIRED`).
- **En contra:** cambiar una variable exige reiniciar el contenedor, que es justo lo que la propiedad prohíbe, y no deja historial de qué corrió en cada ciclo.

### B. Configuración en memoria, editable por la API

- **A favor:** cambia al instante, sin reinicio.
- **En contra:** se pierde al reiniciar `master`, como los timers en memoria descartados en el ADR 0003. Además, si el cambio aplica de inmediato, un mismo ciclo corre con dos estrategias y RF06 ya no puede atribuirlo a un solo span.

### C. Configuración versionada en Postgres, congelada al inicio de cada ciclo

- **A favor:** sobrevive a reinicios, deja historial completo y cada ciclo usa exactamente una versión. Sigue el mismo patrón append-only del ledger (ADR 0002).
- **En contra:** un cambio no se ve hasta el ciclo siguiente (hasta 20 minutos), y hay que validar la configuración antes de aceptarla.

## Decisión

**C.** Es la única que cumple las dos mitades de la respuesta: aplicar sin reinicio y atribuir cada ciclo a una sola estrategia.

Mecanismo:

1. **Tabla `strategy_versions`, append-only.** Cada cambio desde RF04 (`PUT /config`) inserta una versión nueva con todos los parámetros, quién la creó y cuándo. Nunca se edita una versión anterior.
2. **Congelamiento por ciclo.** Al recibir el `status-statement`, el nodo toma la última versión vigente y la guarda en el ciclo (`cycles.strategy_version`). Todo el ciclo usa esa versión, aunque llegue otra a la mitad.
3. **Políticas como funciones puras con nombre.** Cada política (aceptación, selección, precio, span) se elige por nombre y parámetros desde un registro en el código, por ejemplo `aceptacion: "fifo"` o `span: { tipo: "rotacion", valores: [120, 300, 420] }`. Agregar una política nueva sí requiere deploy; cambiar cuál se usa o sus parámetros, no.
4. **El mecanismo no es configurable.** La reserva por oferta (ADR 0004), la idempotencia con la wallet y la conciliación (ADR 0005), la verificación del `swapToken` y el tope de no pagar un precio efectivo sobre `imbalancePrice` se aplican siempre, con cualquier estrategia.
5. **Validación antes de guardar.** Se rechaza una versión con parámetros imposibles (span después de `lastBidAt`, cantidad negativa, política desconocida). La validación tiene sus propios tests (lección del post-mortem: cada promesa de un ADR necesita una prueba).
6. **Interruptor del mercado.** El permiso operativo `nuevos_compromisos` no es parte de la versión de estrategia y **aplica de inmediato**, no en el ciclo siguiente. Apagado, el nodo deja de publicar ofertas, enviar bids y aceptar bids nuevos, pero sigue resolviendo los swaps y reservas pendientes, el ciclo base y el `negotiation-report`. Cada cambio queda registrado con su hora.

Para RF06, cada ciclo registra el span que efectivamente usó (no solo el configurado), el déficit cubierto vía mercado, el costo frente al baseline y los bids rechazados, enlazados a su `strategy_version`.

## Consecuencias

- La rotación de span ciclo a ciclo es una política más, así que el experimento de RF06 corre sin intervención manual.
- La vista de RF01 muestra en cada ciclo la versión de estrategia usada, y RF04 muestra la vigente y la que aplicará en el próximo ciclo.
- El historial de `strategy_versions` es la evidencia de qué estrategia corrió en cada ciclo, para la demo y para el informe de span (RDOC05).
- Pruebas: un cambio a mitad de ciclo no afecta el ciclo en curso, un reinicio de `master` conserva la versión vigente, y una configuración inválida se rechaza sin cambiar la vigente.