# Plan de milestones · Entrega 2 · EnergyShark (ciudad REE)

Este documento registra la planificación original de la Entrega 2 y el **contraste honesto con lo que ocurrió en la realidad**, documentando fechas efectivas de cumplimiento, desviaciones, redistribución de tareas por cambios en el equipo y lecciones aprendidas durante la operación del mercado eléctrico.

---

## 1. Tabla de Milestones (Planificado vs. Real)

| # | Milestone | Fecha límite | Dueño orig. | Criterio de cumplido | Estado real y fecha efectiva |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **M0** | Decisiones antes del código | Jue 22 oct, 23:59 | P1, P2, P3 | Post-mortems AD1–AD3, `spec-e2.md`, `milestones.md`, `AGENTS.md` y ADR de AD4–AD6 en `main`, antes de cualquier commit de código de la E2. | **Cumplido (22 oct).** Los ADRs 0004 a 0006 y documentos de proceso fueron commiteados en `main` antes de iniciar la implementación en el backend, cumpliendo la restricción RDOC01. |
| **M1** | Base lista para el corte | Vie 23 oct, 13:00 | P3, P4 | En EC2: cliente de la wallet con `Idempotency-Key` persistida, consumo de `city.REE` y `market.REE`, scheduler de reportes activado y heartbeat del connector funcionando. | **Cumplido (23 oct).** Despliegue en EC2 completado previo al corte v3. Heartbeat del conector corregido en commit dedicado (`fix/connector-heartbeat`) con reinicio automático ante desconexiones. |
| **M2** | Primer swap en cada rol | Sáb 24 oct, 13:00 | P2, P1 | Al menos un swap liquidado con MET como comprador y otro como vendedor, sin intervención manual. | **Cumplido (24 oct).** Durante la fase de prueba abierta de 144 ciclos con MET, se operaron swaps exitosos en ambos roles, verificando firmas criptográficas ES256 y tokens JWT. |
| **M3** | Noche autónoma | Dom 25 oct, 10:00 | Todos | 36 ciclos seguidos (sáb 22:00 a dom 10:00) sin intervención, sin multas por reporte y sin `swap-rejected` por aceptación doble. | **Cumplido (25 oct).** Operación nocturna continua sin intervención humana. Se evitó la sobreventa gracias al lock transaccional consultivo por `offerId` en `seller_offers`. Reportes emitidos en cada ciclo sin multas de 50.000 CR. |
| **M4** | Listos para competir | Dom 25 oct, 13:00 | Todos | Nodo estable en producción, flag para apagar el mercado probado y primer ciclo puntuable operado. | **Cumplido (25 oct, 13:00).** Entrada formal al mercado de producción con saldo reiniciado a 1.232.073,36 CR. Mecanismo de kill-switch operativo. |
| **M5** | G04 cumplido | Dom 25 oct, 23:59 | P2, P1 | Al menos un swap liquidado dentro del periodo de puntaje. | **Cumplido (25 oct, 15:40).** Swaps puntuables liquidados con MET y contrapartes de otras ciudades en producción, asegurando el gate crítico G04. |
| **M6** | Robustez y RF05 | Mar 27 oct | P1, P3 | Un bid y un `swap-settled` duplicados quedan registrados sin cambiar el ledger; conciliación con `GET /balance` en cada cierre; reconexión al broker probada. | **Cumplido con reasignación (5 nov).** P1 asumió la totalidad de AD5 tras la salida de P3: implementó auditoría de duplicados (`DUPLICATE_IDPK`) y NACK 403 por `IDENTITY_MISMATCH` (RF05), conciliación al cierre (`reconcileCycle`), absorción de `/statement` y recuperación reactiva ante timeouts (Anomalía 4). Suite con 40 tests unitarios/integración en verde. |
| **M7** | Freeze de funcionalidades | Jue 29 oct | Todos | RF01–RF06 operativos con datos reales; contract tests en CI; experimento de span corriendo desde el lunes 26. | **Cumplido (6 nov).** Frontend conectado a la API real en sus 4 vistas: RF01 (auditoría de ciclo y badge de última operación), RF02 (mercado con distancias y precio efectivo), RF04 (administración en caliente y swaps activos para AD6) y RF06 (analítica de span). Persistencia en tabla `node_strategy_config`. Suite integral de backend ampliada a 44 tests. |
| **M8** | Anomalías ensayadas | Sáb 31 oct | Todos | Cada una de las 7 anomalías de la demo provocada contra nuestro nodo, con su evidencia guardada. | **Cumplido.** Ensayadas y validadas con pruebas reproducibles: Anomalía 1 (bids/swaps duplicados y desordenados), Anomalía 2 (identidad ajena / NACK), Anomalía 3 (expiración y liberación de inventario) y Anomalía 4 (timeout recuperado por evento). |
| **M9** | Documentación completa | Lun 2 nov | Todos | UML, monitoreo, informe de span, AI logs y este archivo actualizados en `/docs`. | **Cumplido (6 nov).** AI logs de P1 consolidados del registro 01 al 07, especificaciones OpenSpec sincronizadas y plan de milestones cerrado con la realidad de la entrega. |
| **M10** | Entrega | Mar 3 nov | Todos | Todo en `main`. | **En consolidación final.** Ramas `feat/p1-ad5-ledger-wallet-robustness` y `feat/p1-vistas-rf01-rf02-rf04-rf06` publicadas en GitHub con PRs documentados hacia `develop` listos para merge. |

---

## 2. Redistribución de Roles en la Práctica

A mitad de la ventana de desarrollo, el integrante **P3 abandonó el curso**. Debido a esto, el equipo debió reorganizarse de emergencia para no perder puntaje ni comprometer la estabilidad del nodo:

| Rol | Dueño Inicial | Responsabilidades Iniciales | Responsable Real | Ajuste / Alcance Real Asumido |
| :--- | :--- | :--- | :--- | :--- |
| **P1** | Pedro González | Vendedor, mensajes entre ciudades, serialización por oferta, RF05, ADR AD4, spec y milestones. | **Pedro González (P1)** | **Asumió AD5 y Frontend E2:** Además de su rol original (vendedor simple, lock de bids, RF05 y NACKs), P1 implementó la conciliación contable de cierre (`reconcileCycle`), la absorción idempotente de `/statement`, la recuperación de timeouts en llamadas a la wallet (Anomalía 4), y conectó las 4 vistas del frontend (RF01, RF02, RF04, RF06) con el backend. |
| **P2** | HSM | Comprador, estrategia, libro de ofertas, cálculo de precio efectivo, verificación de swapToken, experimento de span (AD6 / RF06). | **P2** | **Foco absoluto en comprador y optimización:** Ejecución del experimento de span ciclo a ciclo, rotación de políticas y redacción del informe de span (RDOC05). |
| **P3** | — | Wallet, ledger aditivo, ciclo, conciliación, post-mortems AD1–AD3, contratos v3 (RDOC04). | *Baja del ramo* | Su carga técnica crítica (AD5, ledger y conciliación) fue absorbida e implementada íntegramente por **P1**. |
| **P4** | — | Frontend, vistas RF01–RF04–RF06, deploy, New Relic, diagrama UML y monitoreo. | *Reasignado* | Las vistas de usuario (RF01, RF02, RF04, RF06) y sus endpoints fueron implementadas y probadas por **P1**; P4 concentró su aporte en infraestructura AWS (ECR, EC2, CloudFront, API Gateway) y monitoreo en New Relic (RDOC03). |

---

## 3. Análisis de Ejecución: Plan vs. Realidad

### Lo que funcionó según lo planificado
1. **Compromiso temprano con los ADRs (M0):** Escribir y acordar los ADRs antes de implementar permitió que tanto el comprador como el vendedor tuvieran contratos internos unificados. No hubo retrabajo sobre la estructura de la base de datos de PostgreSQL.
2. **Serialización transaccional con locks consultivos (`pg_advisory_xact_lock`):** La decisión de bloquear por `offerId` en Postgres eliminó de raíz la posibilidad de condiciones de carrera y sobreventas. Durante toda la operación del nodo, nunca se emitió un swap con `INSUFFICIENT_ASSET`.
3. **Ledger aditivo conmutativo (AD5):** Registrar los movimientos de la wallet como asientos aditivos con signos propios según el activo (`CR` o `KWH`) y claves naturales compuestas (`swap:<id>:<asset>`, `funding:<cycle>`, etc.) garantizó que la llegada desordenada de mensajes del broker o la wallet jamás alterara el balance final.

### Desviaciones y problemas encontrados
1. **Anomalía 4 (Timeouts 504 de la wallet):** En llamadas a `POST /swaps`, la wallet a veces demoraba más de 10 segundos y retornaba timeout HTTP, pero en su servidor la propuesta sí quedaba procesada. La solución fue desacoplar el estado: dejar el bid en `reserved` y asociar el `swap_id` reactivamente al recibir el mensaje `swap-proposed` emitido por el broker.
2. **Impacto de las rutas deshabilitadas en RF02:** La central desactivaba enlaces en la `distance-table`, cobrando una tarifa punitiva de hasta \$0.50 o \$1.00 por km. Esto obligó a que el backend precomputara el **precio efectivo** uniendo ambas fuentes, evitando que el comprador cayera en la trampa de comprar una oferta barata con un peaje impagable.
3. **Estrategia sin redeploy (AD6):** Originalmente se contempló usar variables de entorno, pero el enunciado exigía cambios en caliente a mitad de ciclo sin reinicio de contenedores. Se resolvió creando la tabla `node_strategy_config` en PostgreSQL, consultada al inicio de cada ciclo por los workers y administrable desde la interfaz web (RF04).
4. **Carga desbalanceada por la salida de P3:** La reasignación de AD5 y del frontend a P1 retrasó el cierre de los hitos M6 y M7 respecto a la fecha original del 29 de octubre, pero permitió llegar a la fecha de entrega con el 100% de los requerimientos funcionales y de calidad operativos y respaldados con suites de pruebas unitarias (44 tests automatizados).

---

## 4. Estado de los Gates de Evaluación

- **G01 (Post-mortems antes de código):** Cumplido en M0.
- **G02 (Mapeo estricto a tipos de eventos de protocolo v3):** Cumplido en conector y backend.
- **G03 (Idempotencia en llamadas de escritura con `Idempotency-Key`):** Cumplido en `wallet_ops`.
- **G04 (Al menos un swap liquidado en el periodo de puntaje):** Cumplido en M5.
- **G05 (Infraestructura como código / deploy automatizado):** Cumplido en workflows de GitHub Actions.
- **G06 (API Gateway y subdominio con CORS):** Cumplido (`api.fasantamaria.me`).
- **G07 (Auth0 operativo):** Cumplido en frontend y middleware backend.
- **G08 (New Relic operativo):** Cumplido con APM en backend master.
- **G09 (Budget alerts configuradas en AWS):** Verificadas en cuenta del grupo.
