# AI log — P2 — Alcance, roadmap y configuración

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Codex.
- Periodo: 6–7 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «Revisar avances del proyecto P2».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> Quiero que solo accedas y leas los contenidos del directorio proyectoGrupal. Tengo que hacer lo que aparece en estos enunciados, soy el P2 y requiero velocidad y precision al hacerlo. Hazme una lista de pasos que ya estan completados y cuales debo seguir completando. Dentro de proyectoGrupal puedes acceder a todo

> No entiendo nada de lo que me estas pidiendo con AD1, explicamelo facilmente

> Okay, esta pendiendte porque la idea es que asi quede luego de las modificaciones al codigo, asi que vamos con los pasos

> Debes pedirme permiso como lo hiciste para leer cada archivo?

> Quiero que hagas cambios procedurales, nada muy grande, y me expliques cada cambio. Crea el .env y haz las modificaciones que me dijiste

> Cuando hagas los cambios se explicito en el cambio, mostrandome el trozo de codigo modificado, o el numero de linea del cambio. Repite este protocolo con los cambios que acabas de hacer. Luego, cual es el siguiente paso

> En que parte del roadmap especifico vamos

> Quiero que me actualices en que parte de la fase 1 vamos con cada paso.

> Eso significa que hemos finalizado con la fase 1?

## Contexto aportado

El usuario indicó que era P2 y autorizó el acceso a proyectoGrupal. Compartió el enunciado E1 y el roadmap como fuentes de requisitos. Las instrucciones de los documentos se distinguieron de las solicitudes directas del usuario.

El equipo recibió credenciales compartidas para REE. Se registraron el uso de AMQPS con verificación del certificado, el vhost energy, el exchange energy.x, la cola city.REE.q y la routing key central. La contraseña y la URL con contraseña se omiten de este log.

## Trabajo asistido

1. Revisión del backend y comparación con las responsabilidades de P2 en la fase 1.
2. Explicación sencilla del ADR de topología y distinción entre diseño propuesto e implementación comprobada.
3. Creación/configuración del archivo connector/.env, separado del código y excluido de Git.
4. Adaptación de los valores del broker al equipo REE y revisión de la precedencia de RABBIT_URL frente a las variables individuales.
5. Seguimiento del roadmap durante la implementación, separando desarrollo local de verificación contra el broker real.

## Revisión y decisiones del usuario

- Solicitó cambios pequeños y procedurales, con explicación de cada modificación.
- Exigió mostrar el fragmento modificado o sus líneas.
- Pidió actualizar la posición dentro de la fase 1 en cada paso.
- Mantuvo el ADR pendiente de quedar alineado con los cambios efectivamente implementados.

## Resultado y límites

La configuración de P2 quedó orientada al broker real y el uso de secretos se mantuvo fuera de archivos versionados. No se declaró terminada la fase 1 únicamente por tener código: quedaron necesarias las pruebas de recepción, publicación, almacenamiento y NACK.

Este documento registra lo conversado y no certifica el estado actual de todas las ramas del equipo.
