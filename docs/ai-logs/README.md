# AI Logs — EnergyShark (Grupo 3 · Ciudad REE)

Este directorio contiene el registro consolidado de interacciones con herramientas de Inteligencia Artificial (Codex y Google Antigravity) utilizadas durante el desarrollo de la Entrega 1 (E1) del proyecto **EnergyShark** (IIC2173 — Arquitectura de Sistemas de Software).

La documentación sigue un esquema modular por integrante y responsabilidad técnica, respaldando los requerimientos de autoría, trazabilidad y supervisión humana (criterio RDOC02).

---

## Índice por Integrante y Rol

| Módulo | Responsable | Rol / Alcance Principal | Herramientas | Enlace |
| :--- | :--- | :--- | :--- | :--- |
| **P2** | Juan Garrido | Protocolo AMQP v2, contratos JSON Schema, broker RabbitMQ, despliegue base y persistencia PostgreSQL. | Codex | [Ver logs P2](P2/README.md) |
| **P3** | Pedro | Ledger inmutable append-only, demandas de central, negociaciones voluntarias (take/give ≤30s), liquidación contable y scheduler durable de reportes. | Codex / Antigravity | [Ver logs P3](P3/README.md) |
| **P5** | Pedro | Scaffold en React/Vite, sistema de diseño "Océano Eléctrico", autenticación y vistas de producción (RF01, RF02, RF04, RF05). | Antigravity | [Ver logs P5](P5/README.md) |

---

## Estructura Estándar de los Registros

Cada subcarpeta (`P2/`, `P3/`, `P5/`) dispone de:
1. Un archivo `README.md` que detalla el alcance del rol, la tabla de sesiones cronológicas y el estado que respaldan los registros.
2. Archivos cronológicos individuales nombrados bajo la convención:
   ```text
   YYYY-MM-DD-p<N>-<XX>-<tema-resumido>.md
   ```
3. Cada registro individual contiene obligatoriamente:
   - **Metadatos**: Integrante, herramienta, fecha/zona horaria, fuente y tipo de registro.
   - **Prompts relevantes**: Instrucciones del usuario citadas fielmente en bloques `> `.
   - **Contexto aportado**: Restricciones, reglas del enunciado, credenciales omitidas y decisiones de alcance.
   - **Trabajo asistido**: Resumen numerado de la implementación guiada por la IA.
   - **Revisión y decisiones del usuario**: Correcciones aplicadas por el operador humano, rechazo de propuestas y límites impuestos.
   - **Resultado y límites**: Commits, pruebas ejecutadas y advertencias de no-despliegue o configuración pendiente.

---

## Criterios Globales de Edición y Trazabilidad

- **Sin transcripciones vacías**: Se omitieron mensajes de mera continuidad operacional ("continúa", "paso siguiente", "ok") para mantener el foco en las decisiones arquitectónicas sustantivas.
- **Seguridad**: Todas las credenciales sensibles (claves de RabbitMQ, contraseñas de bases de datos, tokens JWT) fueron redactadas u omitidas.
- **Fidelidad**: Las propuestas descartadas y los errores de diagnóstico resueltos fueron preservados para evidenciar el proceso real de iteración y resolución técnica.
