# AI log — Francisco — Operación del mercado y cierre de la Entrega 2

- Integrante: Francisco, equipo EnergyShark, ciudad REE. En la última semana tomó también tareas del reparto de P3 y P4.
- Herramienta: Claude (aplicación de Claude).
- Accesos del asistente: repositorio `Arqui-grupo3/backend` en GitHub con permiso de solo lectura; copia local del backend conectada a la conversación; un Postgres y un RabbitMQ de prueba propios; el navegador integrado de la aplicación para leer el enunciado en Notion. Sin acceso a la EC2 ni a New Relic: los comandos los corrió el usuario y pegó las salidas.
- Periodo: 24 de octubre al 5 de noviembre de 2026; zona America/Santiago.
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

Continúa el registro [Ciclo base y configuración](2026-10-24-p1-e2-ciclo-base-y-config.md). Se omitieron los mensajes de mera continuación y los que solo pedían un comando. Las salidas de terminal y las capturas pegadas se resumen en el contexto de cada sección. Los prompts se citan tal como se escribieron.

---


## 1. Comprador: el error del transporte y la deuda

### Prompts relevantes

> lo subi justo de que empezara el ciclo, importa para este?

> cuanto perdemos por no comprar? cuenta como no participar?

> implementa el punto 1, y revisa con que factor estamos vendiendo actualmente

> un compañero de equipo me mando esto dame tu opinion

> Hay dos configuraciones desconectadas (`/config` y `/buyer/config`)
> quiero que arregles esto

> quiero preguntarle al ayudante sobre la deuda que tenemos y si hay algun modo de que suba o vamos a quedar sin comprador, me lo redactas?

> esto me dijo el ayudante

### Contexto aportado

Consultas que cruzaban los ciclos con déficit, las ofertas de MET y los bids del comprador, más el `trade-recorded` de una venta. También la revisión de un compañero sobre tres fallas del comprador y la respuesta del ayudante sobre la línea de crédito.

### Trabajo asistido

- **Error de escala en el transporte:** el comprador multiplicaba `distance × transportCost`, cuando la distancia viene en metros y el costo es por kWh·km. Calculaba 6.588 CR por kWh hacia MET en vez de 6,59, y descartaba todas las ofertas sin dejar nada en el log. Se reprodujo en la EC2 con la oferta y la tabla reales, se confirmó con el `transportPerEnergy` del `trade-recorded` y se corrigió con una prueba que usa esos datos (PR #35). El primer bid real llegó en el ciclo 249230.
- **Deuda y línea de crédito:** se dedujo de los datos, y después se confirmó en el enunciado, que `creditLine` es 2 × el financiamiento del ciclo. Con el saldo en −19,5 M CR la wallet rechaza toda compra. En 24 horas, los 27 ciclos con déficit dejaron −63,4 M, los 45 con excedente +37,2 M y las ventas +14,1 M, así que la deuda crecía unos 12 M al día.
- **Comprador:**
  - limita la compra a `available + creditLine` (PR #37);
  - una sola configuración para comprador y vendedor, con `/buyer/config` como alias de `/config` y la migración 014 que traspasa el span de 420 s (rama `fix/config-unificada`).

  La revisión del compañero coincidió en las tres fallas. Dos las corrigió él: el reintento tras `QUANTITY_UNAVAILABLE` y el transporte de los bids pendientes (PR #41 y #42).
- **Consulta al ayudante:** se redactaron dos versiones del mensaje con los números. El ayudante confirmó que el enunciado no trae un mecanismo para volver a la línea de crédito, lo escaló al equipo docente y recomendó guardar la evidencia del comprador.

### Decisiones del usuario

Planteó apagar el nodo para no seguir pagando desbalance. Con el análisis (el saldo no cuenta para el score, el riesgo de multas y lo que pide la evaluación), decidió mantenerlo arriba y consultar al ayudante.

---

## 2. Cierre: reparto, post-mortem, CI y documentación

### Prompts relevantes

> el p4 dejo de trabajar, quiero que repartas su parte entre el p1, p2 y p3. considera que los puntos anteriores que tenia que hacer el p4 los hizo el p3

> quiero que hagas la documentacion del transporte en un postmortem, ponlo en la carpeta de los adr.

> armame el ci.yml y los script de pruebas. pasame el comando. yo soy el p3

> un compañero de grupo necesita esto de new relic, de donde lo saco?

> P3: UML, pasos de monitoreo y cómo correr local (RDOC03)
> quiero hacer este paso, partamos con los pasos de monitore, luego el como correr local, por ultimo, quiero actualziar el uml que ya tenemos

> quiero que basandote en el diagramauml que ya tenemos, me digas paso a paso que actualizar para que quede acorde a esta entrega

### Trabajo asistido

- **Reparto de las tareas de P4** entre P1, P2 y P3, según qué conoce cada uno y cuánta carga tenía.
- **Post-mortem del transporte** en `docs/ADR/postmortem-transporte-comprador.md`: línea de tiempo, impacto, causa raíz, por qué tardó la detección, acciones y lecciones.
- **CI y contract tests** (PR #43 y #44):
  - `ci.yml` corre las pruebas de `master` (con Postgres) y del connector en cada PR, y `deploy.yml` no despliega si fallan;
  - script de pruebas del connector;
  - `contracts/central-real.json` con mensajes reales de producción y pruebas que los validan (por ejemplo, el transporte calculado tiene que ser igual al que cobró la central).

  Al armarlo se encontró que `main` tenía 67 pruebas fallando: la migración `014-distance-publication.sql` no estaba registrada y faltaba una función de prueba, ambas perdidas en un merge. Se corrigieron en el mismo PR.
- **New Relic:** consultas NRQL de p50/p95 y de errores sobre el evento `WalletCall`. Revisando la pauta, las alertas al celular no suman puntaje (lo que cuenta es G08, RNF05 y RDOC03) y el connector no tiene agente propio, que es un hueco para el RNF05.
- **RDOC03:**
  - `docs/monitoreo.md` actualizado para la E2;
  - en el `README.md`, la puesta en marcha local con un RabbitMQ propio (`docker-compose.local.yml`, `scripts/broker-local.sh`, `scripts/publicar-local.sh` y mensajes de ejemplo), probada con un RabbitMQ y un Postgres reales;
  - el paso a paso para actualizar el diagrama UML con las dos colas, la wallet y dónde vive la estrategia.

### Errores del asistente

- En una consulta de flujos por tipo de ciclo, todos los ciclos quedaron clasificados como déficit por filtrar solo los efectos en CR. Se corrigió en la consulta siguiente.
- La guía de alertas usaba `status IS NULL` para las fallas de red, pero el código registra `0`. Se corrigió en `monitoreo.md`.
- El CI implementado valida contra las reglas propias y contra mensajes reales, pero el RDOC04 pide validar contra los schemas publicados por el curso en un repo de contratos de la organización. Quedó señalado como pendiente.

### Decisiones del usuario

Decidió no recibir las alertas en el celular y dejar en la guía local solo la opción con broker propio. Subió cada cambio con sus propios PR.

---

## Resultado y límites

- **En producción al cierre de este registro:**
  - configuración en caliente única para vendedor y comprador;
  - vendedor con bajada de precio y liberación de accepts rechazados;
  - comprador con el transporte corregido y el límite de crédito;
  - CI con contract tests.
- **Ventas:** más de 15 a MET, todas liquidadas; el primer swap del periodo de puntaje (ciclo 249224) cumple el G04. El score llegó a 0,0376 (segundo lugar) el 27 de octubre.
- **El comprador no alcanzó a liquidar ninguna compra:** cuando se corrigió el transporte, la cuenta ya estaba fuera de la línea de crédito. Queda la evidencia del flujo completo hasta el accept rechazado por la wallet (ciclo 249230).
- **Pendientes:** instrumentar el connector en New Relic (RNF05), validar contra los schemas del curso (RDOC04), actualizar la imagen del UML y `docs/arquitectura.md`, y la respuesta del equipo docente sobre la línea de crédito.
