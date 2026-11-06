# AI log — P2 — Informe del experimento de span (RDOC05) y post-mortem del incidente

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Claude Code (Claude Opus 5.5), con acceso a los repos locales, Docker y el navegador.
- Fuente: conversación «Trabajo de Arquitectura de Sistemas de Software (E2)».
- Registro retrospectivo: prompts conservados; respuestas y salidas resumidas.

## Prompts relevantes

> Partamos con lo que es el informe de RDOC05, porque es necesario y que deberia tener

> Estoy pidiendo la latencia del NewRelic, cuando me llegue lo modificamos y subimos

> info de newrelic

El último prompt adjuntó dos gráficos y dos CSV exportados de New Relic (latencia p50/p95 por operación de la wallet y la tabla de errores).

## Contexto aportado

- La rúbrica exacta de RDOC05, RF06 y AD6 se leyó del enunciado en Notion con el navegador, porque la página no se podía descargar como texto. El HTML guardado por el usuario solo traía el código de la app de Notion.
- El modelo de ahorro del informe usa la definición del leaderboard (`baseline − real`, normalizado por `|baseline|`), restringida a la compra.

## Trabajo asistido

1. Estructura del informe derivada de la rúbrica: qué valores, en qué ciclos, qué se observó, qué se concluye, qué se midió de la wallet y lo que no se puede concluir.
2. Consultas SQL de solo lectura (`docs/informe-span-consultas.sql`), probadas primero contra un Postgres desechable con datos sintéticos y verificadas a mano. Un primer error de tipo en la variable `corte` se corrigió con un cast a `timestamptz`.
3. Contrafactual desde `market_feed`: para cada ciclo con déficit y cada span candidato, el estado del libro en `opensAt + s`. Resultado: el mejor precio disponible baja de 68.5 % del `imbalancePrice` a los 60 s a 21 % a los 530 s, con disponibilidad casi constante desde los 180 s. Recomendación del informe: 480 s.
4. Asistencia en el Post-mortem del incidente del 27-10 al 05-11 agregado a `docs/ADR/postmortem-AD1-AD3.md`: causa, impacto.
5. Datos de New Relic incorporados: p50/p95 por operación y un 503 en un `propose`, que coincide con el único reintento registrado en `wallet_ops` (25 propuestas en la base, 26 requests en New Relic).

## Revisión y decisiones del usuario

- El usuario pidió que el informe fuera honesto sobre lo que no se hizo, en vez de forzar conclusiones.
- La IA había escrito que el feed de mercado de los días caídos no existía; los datos lo contradijeron y se corrigió en el informe y en el post-mortem.
- Una afirmación sobre la causa del atraso de tres bids (485 s en vez de 420 s) se reescribió como no verificada, porque no había registro que la respaldara.

## Resultado

- `docs/informe-span.md`, `docs/informe-span-consultas.sql` y `docs/diagnostico-comprador.sql` (los `.sql` agregados con `git add -f` por el `.gitignore`).
- Commit `44d42e5`, incluido en el PR #45, mergeado a `main`.

Este registro es histórico. Las cifras del informe corresponden a las consultas corridas el 5 de noviembre.
