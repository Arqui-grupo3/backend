# AI log — P1 — Planificación, artefactos de proceso y decisiones de arquitectura

- Integrante: P1 (Francisco), equipo EnergyShark, ciudad REE.
- Herramienta: Claude.
- Periodo: 21–23 de octubre de 2026; zona America/Santiago.
- Fuente: conversación en la aplicación de Claude.
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

**Roadmap y reparto**

> https://arquisispuc.notion.site/2026-2-iic2173-entrega-2
> quiero que me hagas un roadmap y repartas tareas de manera equitativa entre 4 personas

> cuales de los requisitos funcionales son nuevos respecto a la entrega 1

> [adjunta el enunciado de la E1 en PDF] con respecto a la gate de correccion

> que partes del roadmap habria que priorizar para empezar a competir el domingo?

**Spec, milestones y AGENTS.md**

> armame un ejemplo de spec y de lo que deberia tener, no hicimos uno en la primera entrega asi que no tenemos formato

> quiero que armes el AGENTS.md y el milestone en base al roadmap y el spec hecho anteriormente

> en el spec que hiciste, a que se deben los valores del ciclo?

**ADR y post-mortems**

> quiero que revises los adr y el proyecto, y armes un postmortem en base a estos

> ahora quiero que me aydues con los adr. partamos por el 4. quiero que me des opciones de que podemos hacer y que armes un adr con el mismo formatos de lo hechos anteriormente

> quiero que sea mas resumido y que no pongas la opcion a

> quiero que me ayudes con el adr 5, dame opciones de lo que podriamos hacer y redactame un posible documento para editarlo yo

> la decision es consistente con el postmortem hecho anteriormente?

> quiero que hagas lo mismo que hiciste en el 5 pero con el 6. tienes que seguir siendo consistene con el postmortem. acuerdate de darme varias opciones para ver cual acpetamos.

> [adjunta una revisión de los documentos hecha por un compañero] que opinas de esto?

> editalos y ademas quiero que hagas mas resumido el postmortem

## Contexto aportado

El usuario entregó el link público del enunciado de la E2 en Notion, que la IA leyó completo. También conectó una copia local del backend y el frontend de la E1 (ADR 0001–0003, código, historial de git y carpeta `evidencia/`) y adjuntó el enunciado de la E1 en PDF. Más adelante se supo que esa copia no era la oficial (último commit del 7 de octubre).

Requisitos que orientaron el trabajo: RDOC01 (ADR de AD4–AD6 escritos antes de implementar y post-mortems de AD1–AD3), RDOC02 (spec y milestones) y RDOC04 (archivo de contexto compartido). Al leer el enunciado completo se detectó que el periodo de puntaje empieza el domingo 25 a las 13:00.

## Trabajo asistido

1. **Roadmap** con fechas clave, roles, reparto de puntaje, riesgos y un diagrama de fases. Después se priorizó para competir desde el domingo: antes del corte, solo lo que afecta el score o los gates; las vistas y la documentación, después.
2. **Spec** (`spec-e2.md`), **milestones** (M0 a M10 con criterio verificable) y **`AGENTS.md`** compartido, más uno corto para cada repositorio que lo referencia. Las fórmulas de los valores del ciclo se agregaron al `AGENTS.md` con su regla de redondeo.
3. **Post-mortems de AD1–AD3** a partir del código y la evidencia. Hallazgos que los ADR no mostraban: el heartbeat del connector nunca se escribía, el tope de reintentos no existía y el reporte automático estaba apagado por defecto.
4. **ADR 0004** (reserva persistida antes de llamar a la wallet), **0005** (efectos con clave propia y conciliación por ciclo) y **0006** (configuración versionada y congelada por ciclo).
5. **Revisión de consistencia** entre ADR y post-mortems, con dos correcciones (snapshot por ciclo y alcance del `idpk`).
6. **Aplicación de la revisión del compañero:** recuperación ante un 202 perdido, cupo de compra, lock por ciclo, doble conteo entre conciliación y evento tardío, interruptor de emergencia inmediato, distinción entre `ack` de aplicación y `channel.ack`, y criterios para todos los gates y RNF en el spec.

## Revisión y decisiones del usuario

- Definió el reparto entre 4 personas y pidió priorizar para competir desde el domingo en vez de seguir el roadmap original.
- Acordó dejar en el `AGENTS.md` solo las fórmulas y mantener la explicación en el spec.
- Pidió un ADR 0004 más corto y sin la alternativa de dejar que la wallet arbitre.
- Exigió consistencia entre los ADR y los post-mortems, llevó los documentos a revisión de un compañero y pidió aplicar sus observaciones.
- Pidió reducir el post-mortem. Se eliminó la afirmación sobre `rejected_messages`, porque no se pudo verificar contra el repo oficial.

## Resultado y límites

El roadmap quedó como documento compartido, y el spec, los milestones, el `AGENTS.md`, los tres ADR y los post-mortems, listos para commitearse antes del código de la E2. Quedaron como tareas previas a implementar dos verificaciones contra la Referencia de la API v3 (qué devuelve un reintento con la misma `Idempotency-Key` y qué campo comparten los asientos de `/statement` con sus eventos). Las secciones "Observado en la E2" del post-mortem se completan después del periodo de prueba. El reparto es una propuesta para acordar con el grupo.
