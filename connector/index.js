require('dotenv').config();
const amqp = require('amqplib');

const {
  RABBIT_URL,
  RABBIT_HOST = 'broker.iic2173.org',
  RABBIT_PORT = '5671',
  RABBIT_USER,
  RABBIT_PASS,
  RABBIT_VHOST = '',
  RABBIT_QUEUE,
  MASTER_URL = 'http://localhost:3000/events',
} = process.env;

if (!RABBIT_URL && (!RABBIT_USER || !RABBIT_PASS)) {
  console.error(
    'Faltan credenciales. Define RABBIT_URL (URL completa) o RABBIT_USER/RABBIT_PASS ' +
      '(copia .env.example a .env y completa tus datos).'
  );
  process.exit(1);
}

if (!RABBIT_QUEUE) {
  console.error('Falta RABBIT_QUEUE (ej: observer.46.q) en tu .env.');
  process.exit(1);
}

const RECONNECT_DELAY_MS = 5000;
const MASTER_RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl() {
  if (RABBIT_URL) return RABBIT_URL;

  const vhost = RABBIT_VHOST ? `/${encodeURIComponent(RABBIT_VHOST)}` : '';
  return `amqps://${encodeURIComponent(RABBIT_USER)}:${encodeURIComponent(
    RABBIT_PASS
  )}@${RABBIT_HOST}:${RABBIT_PORT}${vhost}`;
}

async function main() {
  const url = buildUrl();

  console.log(`[connector] Conectando a ${RABBIT_HOST}:${RABBIT_PORT} ...`);

  let connection;
  try {
    connection = await amqp.connect(url, {
      // Si el handshake TLS falla por el certificado del broker, puedes
      // descomentar la siguiente linea SOLO para pruebas locales.
      // Nunca la dejes asi en producción / en la entrega final.
      // rejectUnauthorized: false,
    });
  } catch (err) {
    console.error('[connector] Error al conectar:', err.message);
    console.log(`[connector] Reintentando en ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(main, RECONNECT_DELAY_MS);
    return;
  }

  connection.on('error', (err) => {
    console.error('[connector] Error de conexión:', err.message);
  });

  connection.on('close', () => {
    console.warn('[connector] Conexión cerrada. Reintentando en ' + RECONNECT_DELAY_MS / 1000 + 's...');
    setTimeout(main, RECONNECT_DELAY_MS);
  });

  const channel = await connection.createChannel();
  await channel.prefetch(1);

  console.log(`[connector] Escuchando la cola "${RABBIT_QUEUE}"...`);

  channel.consume(
    RABBIT_QUEUE,
    async (msg) => {
      if (msg === null) return;

      const receivedAt = new Date().toISOString();

      let event;
      try {
        const raw = msg.content.toString('utf8');
        event = JSON.parse(raw);
      } catch (err) {
        console.error('[connector] No se pudo parsear el mensaje, se descarta:', err.message);
        channel.nack(msg, false, false);
        return;
      }

      console.log(`[connector] Evento recibido idpk=${event.idpk} type=${event.type}`);

      try {
        const response = await fetch(MASTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...event, receivedAt }),
        });

        if (!response.ok) {
          throw new Error(`master respondió ${response.status}`);
        }

        console.log(`[connector] Enviado a master OK (idpk=${event.idpk})`);
        channel.ack(msg);
      } catch (err) {

        console.error('[connector] No se pudo enviar a master, se reencola:', err.message);

        await sleep(MASTER_RETRY_DELAY_MS);
        channel.nack(msg, false, true);
      }
    },
    { noAck: false }
  );
}

main().catch((err) => {
  console.error('[connector] Error inesperado:', err);
  setTimeout(main, RECONNECT_DELAY_MS);
});
