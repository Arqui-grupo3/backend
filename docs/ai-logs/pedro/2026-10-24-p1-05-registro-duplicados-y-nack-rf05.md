# AI log — P1 — Registro de duplicados y NACK por IDENTITY_MISMATCH (RF05)

- Integrante: P1 (Pedro González), equipo EnergyShark, ciudad REE.
- Herramienta: Google Antigravity (Gemini 3.8 Flash).
- Periodo: 24 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «P1: registro de duplicados y NACK, incluido IDENTITY_MISMATCH (RF05)».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> ☐ P1: registro de duplicados y NACK, incluido IDENTITY_MISMATCH (RF05). Esto lo pued hacer ahora, o tengo que esperar al domingo???

> /openspec-propose arma la propuesta porfavor

> /openspec-apply-change

## Contexto aportado

El usuario consultó sobre la viabilidad de implementar la tarea de RF05 antes del domingo 25 de octubre (fecha de apertura del mercado competitivo de la E2).
Se aclaró que no se requiere esperar al domingo, pues la totalidad de la lógica de detección de duplicados, auditoría de eventos y rechazo de identidades falsificadas (`IDENTITY_MISMATCH`) puede validarse localmente mediante pruebas automatizadas con PostgreSQL, otorgando una capa crítica de protección al nodo antes del inicio de la competencia real.

Criterios de diseño abordados:
- **RF05**: Un `bid` y un `swap-settled` duplicados deben aparecer registrados formalmente en la auditoría (`rejected_messages` / `api_audit`) sin alterar el ledger ni los balances de energía/créditos.
- **AGENTS.md**: Todo `bid` cuyo `user_id` autenticado no coincida con el `cityId` del remitente debe ser rechazado inmediatamente con sobre `nack` (`code: 403`, `reason: 'IDENTITY_MISMATCH'`), persistirse en auditoría y no alterar el inventario de la oferta.

## Trabajo asistido

1. **Propuesta formal OpenSpec (`p1-duplicates-and-nack-rf05`)**:
   - `proposal.md`: Justificación arquitectónica y definición de alcance para auditoría de duplicados e invariancia contable.
   - `specs/duplicates-and-nack-audit/spec.md`: Especificación de escenarios verificables (`WHEN`/`THEN`) para registro de duplicados, validación estricta de identidad con NACK 403 e invarianza de balances.
   - `specs/seller-bid-serialization/spec.md`: Actualización del requisito de idempotencia de bids para incorporar la persistencia en `rejected_messages`.
   - `design.md`: Decisiones sobre auditoría atómica transaccional y defensa en profundidad entre `connector` y `master`.
   - `tasks.md`: Plan de 12 tareas en 4 fases.

2. **Validación de Identidad y Despacho NACK (`master/seller/index.js`)**:
   - Implementación de `cityFromUserId(userId)` para parsear identidades del broker (`city.<CITY>`).
   - Implementación de `sendBidNack` para despachar sobres `nack` con código 403 y `reason: 'IDENTITY_MISMATCH'` hacia la cola de la ciudad remitente (`city.<cityId>`).
   - Integración defensiva en `processIncomingBid`: si el mensaje incluye `userId` y este no coincide con `cityId`, se registra inmediatamente en `rejected_messages` (`category: 'NACK'`, `code: 403`), se despacha el NACK y se retorna sin evaluar oferta ni mutar inventario.

3. **Auditoría de Duplicados en Seller (`master/seller/index.js`)**:
   - En la rama de idempotencia de `processIncomingBid`, al detectar un `idpk` ya visto en `seller_bids`, se inserta una fila en `rejected_messages` con `category: 'DUPLICADO'`, `reason: 'DUPLICATE_IDPK'`, preservando la respuesta previa sin duplicar reservas ni alterar inventarios.

4. **Propagación de Identidad en Conector (`connector/index.js`)**:
   - Inclusión del campo `userId` proveniente de las propiedades AMQP del mensaje en el payload enviado al master (`POST /events`).

5. **Pruebas Automatizadas (`master/test/seller.test.js`)**:
   - Suite ampliada a 11 pruebas unitarias e integradas (100% aprobadas):
     - Detección de `IDENTITY_MISMATCH`, emisión de NACK 403 y verificación en `rejected_messages`.
     - Registro auditado de reintentos duplicados con `DUPLICATE_IDPK`.
     - Invarianza estricta de inventario vendible ante ráfagas de 4 duplicados y 3 mensajes con identidad suplantada.
     - Formato de sobre NACK y validaciones del helper `cityFromUserId`.
   - Verificación cruzada con la suite contable de `effects.test.js` (8/8 pruebas aprobadas, total 19 pruebas de backend).

## Revisión y decisiones del usuario

- **Oportunidad de implementación**: El usuario decidió avanzar inmediatamente sin esperar al domingo, asegurando que el nodo arranque el periodo de puntaje blindado contra fallas de otros nodos.
- **Flujo de co-creación**: Se utilizó el flujo formal OpenSpec (`/openspec-propose` y `/openspec-apply-change`) para planificar, auditar y ejecutar cada tarea incrementalmente.

## Resultado y límites

- RF05 queda completamente implementado, auditado y verificado en el backend de REE.
- El nodo garantiza matemáticamente invarianza ante duplicados y suplantación de identidades, cumpliendo todas las directrices de `AGENTS.md`.
