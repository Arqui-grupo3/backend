# Plan de milestones · Entrega 2 · EnergyShark (ciudad REE)

## Milestones

| # | Milestone | Fecha límite | Dueño | Criterio de cumplido | Estado real |
| --- | --- | --- | --- | --- | --- |
| M0 | Decisiones antes del código | Jue 22 oct, 23:59 | P1, P2, P3 | Post-mortems AD1–AD3, `spec-e2.md`, `milestones.md`, `AGENTS.md` y ADR de AD4–AD6 en `main`, antes de cualquier commit de código de la E2 | |
| M1 | Base lista para el corte | Vie 23 oct, 13:00 | P3, P4 | En EC2: cliente de la wallet con `Idempotency-Key` persistida, consumo de `city.REE` y `market.REE`, scheduler de reportes activado y heartbeat del connector funcionando | |
| M2 | Primer swap en cada rol | Sáb 24 oct, 13:00 | P2, P1 | Al menos un swap liquidado con MET como comprador y otro como vendedor, sin intervención manual | |
| M3 | Noche autónoma | Dom 25 oct, 10:00 | Todos | 36 ciclos seguidos (sáb 22:00 a dom 10:00) sin intervención, sin multas por reporte y sin `swap-rejected` por aceptación doble | |
| M4 | Listos para competir | Dom 25 oct, 13:00 | Todos | Nodo estable en producción, flag para apagar el mercado probado y primer ciclo puntuable operado | |
| M5 | G04 cumplido | Dom 25 oct, 23:59 | P2, P1 | Al menos un swap liquidado dentro del periodo de puntaje | |
| M6 | Robustez y RF05 | Mar 27 oct | P1, P3 | Un bid y un `swap-settled` duplicados quedan registrados sin cambiar el ledger; conciliación con `GET /balance` en cada cierre; reconexión al broker probada | |
| M7 | Freeze de funcionalidades | Jue 29 oct | Todos | RF01–RF06 operativos con datos reales; contract tests en CI; experimento de span corriendo desde el lunes 26 | |
| M8 | Anomalías ensayadas | Sáb 31 oct | Todos | Cada una de las 7 anomalías de la demo provocada contra nuestro nodo, con su evidencia guardada | |
| M9 | Documentación completa | Lun 2 nov | Todos | UML, monitoreo, informe de span, AI logs y este archivo actualizados en `/docs` | |
| M10 | Entrega | Mar 3 nov | Todos | Todo en `main` | |

## Responsables por área

| Persona | Área |
| --- | --- |
| P1 | Vendedor, mensajes entre ciudades, RF05, AD4, spec y milestones |
| P2 | Comprador, estrategia, RF06, AD6, informe de span |
| P3 | Wallet, ledger, ciclo, AD5, post-mortems, contratos |
| P4 | Frontend, API, infraestructura, monitoreo, UML |
