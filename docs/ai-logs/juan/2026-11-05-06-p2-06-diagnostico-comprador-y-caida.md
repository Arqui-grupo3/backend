# AI log — P2 — Diagnóstico del comprador y caída del nodo (27-10 al 05-11)

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Claude Code (Claude Opus 5.5), con acceso a los repos locales, Docker y el navegador.
- Fuente: conversación «Trabajo de Arquitectura de Sistemas de Software (E2)».
- Registro retrospectivo: prompts conservados; respuestas, consultas y salidas de terminal resumidas.

## Prompts relevantes

> Sucedio que inicialmente generamos un comprador que no era efectivo y rechazaba todas las ofertas, por lo que perdimos todo el credito posible y quedamos en absoluto negativo, donde seguimos. Generando problemas para la experimentacion.

> En el git pull que debo hacer de la rama develop encontraras el postmortem e informacion sobre lo que sucedio

## Problema observado

Las consultas del informe de span, corridas en producción, mostraron tres cosas que no calzaban con lo esperado:

1. Un solo valor de span (420 s) en todo el periodo de puntaje.
2. Cobertura de 0 %: ningún bid del comprador quedó `settled` en 146 ciclos con déficit.
3. Ninguna tabla tenía datos posteriores al 27-10 21:45 UTC, aunque los contenedores figuraban `healthy`.

## Diagnóstico asistido

1. **Despliegue y copia de archivos.** La IA explicó que un push a `main` redespliega el master y no copia `docs/` a la EC2, así que las consultas se pasaron con `scp`. El primer `scp` falló porque faltaba `:` entre el host y la ruta, y se corrigió.
2. **Por qué el comprador no compró.** Un script de diagnóstico (`docs/diagnostico-comprador.sql`) mostró 21 `bid-accepted` recibidos, pero 14 aceptaciones resueltas con `swap-rejected` / `INSUFFICIENT_ASSET` y 7 respuestas descartadas por swap vencido o que no calzaba. Una consulta posterior confirmó que el saldo (−2.4 M a −27.6 M CR) estuvo siempre bajo la línea de crédito.
3. **Por qué no había datos desde el 27-10.**
   - Primera hipótesis, **descartada**: que el master escribiera en otra base. El `env` del contenedor mostró la misma base.
   - Segunda hipótesis, **también descartada**: que el nodo procesara mensajes con atraso. Hoy llegaban eventos del ciclo actual.
   - La tabla `events` mostró que no hubo eventos entre el 28-10 y el 4-11, y que el master se había recreado a las 20:53 UTC del 5-11.
   - Con el `git pull` de develop se encontró la causa: el commit `984419e` (27-10) agregó la columna `published_at` en `recordEvent` y la migración `014-distance-publication.sql`, pero no la sumó a la lista de migraciones que aplica el master. Cada `INSERT INTO events` fallaba y la transacción se deshacía completa. El commit `29484ed` (5-11) lo corrigió.

## Revisión y decisiones del usuario

- El usuario aportó el contexto que los datos no mostraban: el primer comprador rechazaba todas las ofertas y por eso se perdió el crédito.
- Pidió revisar develop antes de seguir especulando sobre la caída, lo que llevó a la causa real.

## Resultado

- Causa de la caída identificada y documentada en el post-mortem (`docs/ADR/postmortem-AD1-AD3.md`, sección del incidente).
- Causa de la cobertura 0 % documentada en el informe de span: bloqueo por línea de crédito.
- Las consultas de diagnóstico son de solo lectura; no se modificó nada en la base de producción salvo las versiones de `strategy_config` insertadas por el cron mientras estuvo activo.

Este registro es histórico. El diagnóstico se basa en las salidas pegadas por el usuario durante la conversación.
