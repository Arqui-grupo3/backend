# AI log — P2 — Persistencia PostgreSQL e incompatibilidad con E0

- Integrante: P2, equipo EnergyShark, ciudad REE.
- Herramienta: Codex.
- Periodo: 6–7 de octubre de 2026; zona America/Santiago.
- Fuente: conversación «Revisar avances del proyecto P2».
- Registro retrospectivo: prompts conservados; respuestas y flujos resumidos.

## Prompts relevantes

> Veamos lo de la direccion de la imagen y la memoria de master. No quiero seguir alargando este trabajo

> Tengo una duda, el compose que acabo de hacer fue dentro del directorio energyshark y no energyshark_e1, puede ser eso la razon que no haya cambiado

> y no podemos cambiar el master antiguo por el nuevo? o requiere una modificacion el nuevo para adaptarse? (prefiero cambiar el nuevo al viejo)

> adaptemos el almacenamiento entonces para que sea de otro tipo persistente con postgresql

> O puedes mantenerte mas conservador con el codigo previo

> Sigues agregando demasiado y ocupando Pool,

## Problema observado

La API devolvió eventos con idpk y type, pero packageBody era null. La ruta del master antiguo recibía packageBody y lo insertaba en events.package_body. El conector E1 enviaba data y los campos del envelope al nivel superior. Por eso una respuesta HTTP exitosa no demostraba almacenamiento completo.

Un ACK nuevo de una solicitud a la central también quedó en null. Esto descartó que el problema se explicara únicamente por consultar una tabla de distancias antigua.

## Opciones y revisión humana

1. Se consideró adaptar el envío del conector para envolver el mensaje en packageBody.
2. El usuario prefirió adaptar y reemplazar el master.
3. Se detectó que la versión nueva revisada inicialmente usaba un arreglo en RAM y que el master desplegado utilizaba PostgreSQL.
4. Un primer cambio más amplio con Pool y consultas nuevas fue rechazado.
5. El usuario pidió conservar más código y objetó el uso de Pool. La implementación finalmente aceptada utilizó Client y mantuvo la estructura previa del historial.

## Cambio finalmente aplicado en esa etapa

- Se añadió pg a package.json y package-lock.json.
- Se creó una conexión Client usando las variables PG* del entorno.
- Se mantuvieron la construcción de record, los filtros y la paginación.
- Antes de agregar el evento a la caché o responder 201, se ejecutó el INSERT en PostgreSQL con record completo en package_body.
- ON CONFLICT (idpk) DO NOTHING protegió contra duplicados.
- Un fallo de INSERT devolvió HTTP 500 para que el conector pudiera reintentar.
- Al arrancar, el proceso recuperó los eventos desde PostgreSQL y después abrió el servidor HTTP.
- events quedó como caché en memoria, recuperable tras reinicio; no como único almacenamiento durable.

## Verificación local

Se utilizó una base PostgreSQL temporal con servidor HTTP real. Se comprobaron el envelope completo, la recuperación idéntica después de reiniciar, la deduplicación tras reinicio, solicitudes duplicadas simultáneas, filas antiguas con contenido null y respuesta 500 ante un fallo de INSERT.

La prueba detectó diferencias de formato en receivedAt y una inconsistencia en packageBody antes/después de reiniciar. Se ajustaron esas líneas y se repitió la comprobación hasta obtener resultado satisfactorio. Las bases temporales se eliminaron.

## Diagnóstico y publicación del commit

El cambio Client quedó en el commit local 778b743 de publisherDev. La EC2 seguía en e0395f8, y main tampoco incluía ese cambio. Tras actualizar las referencias se comprobó que las ramas local y remota habían divergido.

El usuario publicó el commit en codex/master-postgres-client. La EC2 descargó esa rama; grep mostró Client, db.connect y el INSERT del record completo. La construcción de master:e1-postgres y su recreación finalizaron correctamente.

## Estado al cierre del historial

- Cambio conservador probado localmente con PostgreSQL real.
- Código correcto descargado, construido y recreado en la EC2, según la última salida aportada.
- Pendiente: respuesta del nuevo ensayo de almacenamiento en EC2 después de desplegar el commit correcto.
- Pendiente: demostración de NACK contra el broker.
- Los registros anteriores con package_body null no se reparan automáticamente al reenviarlos: ON CONFLICT omite la inserción duplicada.

Este registro es histórico. No describe cambios posteriores realizados en otros chats ni pretende fijar Client como arquitectura definitiva del equipo.
