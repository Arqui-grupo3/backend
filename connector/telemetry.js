let nr = null;
if (process.env.NEW_RELIC_LICENSE_KEY) {
  try {
    nr = require('newrelic');
  } catch (err) {
    console.warn('[telemetry] No se pudo cargar newrelic:', err.message);
  }
}

const QUEUE_DEPTH_INTERVAL_MS = Number(process.env.QUEUE_DEPTH_INTERVAL_MS) || 30_000;

const enabled = () => nr !== null;

function safe(fn) {
  try {
    fn();
  } catch (err) {
    console.warn('[telemetry] Error enviando telemetría:', err.message);
  }
}

function consumer(queue, handler) {
  return async (msg) => {
    if (msg === null) return handler(msg);
    const run = async () => {
      const started = Date.now();
      const info = { attrs: {} };
      let outcome = 'requeue';
      try {
        outcome = (await handler(msg, info)) || 'ack';
        return outcome;
      } catch (err) {
        outcome = 'error';
        safe(() => nr && nr.noticeError(err, { queue }));
        throw err;
      } finally {
        recordMessage(queue, msg, outcome, Date.now() - started, info.attrs);
      }
    };
    return nr ? nr.startBackgroundTransaction(queue, 'RabbitMQ/Consume', run) : run();
  };
}

function lagFrom(timestamp) {
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : null;
}

function recordMessage(queue, msg, outcome, durationMs, attrs = {}) {
  if (!nr) return;
  safe(() => {
    const event = {
      queue,
      outcome,
      durationMs,
      routingKey: msg.fields?.routingKey || null,
      redelivered: Boolean(msg.fields?.redelivered),
      bytes: msg.content?.length || 0,
      type: attrs.type || null,
      cityId: attrs.cityId || null,
      cycleId: attrs.cycleId || null,
      reason: attrs.reason || null,
      lagMs: attrs.timestamp ? lagFrom(attrs.timestamp) : null,
    };
    nr.recordCustomEvent('QueueMessage', event);
    nr.addCustomAttributes(event);
    nr.incrementMetric(`Custom/Queue/${queue}/Messages`);
    nr.incrementMetric(`Custom/Queue/${queue}/Outcome/${outcome}`);
    nr.recordMetric(`Custom/Queue/${queue}/ProcessingMs`, durationMs);
    if (event.lagMs !== null) nr.recordMetric(`Custom/Queue/${queue}/LagMs`, event.lagMs);
  });
}

function recordBroker(state, detail = null) {
  if (!nr) return;
  safe(() => {
    nr.recordCustomEvent('BrokerConnection', { state, detail });
    nr.incrementMetric(`Custom/Broker/${state}`);
  });
}

function recordPublish({ exchange, routingKey, type, outcome, durationMs }) {
  if (!nr) return;
  safe(() => {
    nr.recordCustomEvent('QueuePublish', { exchange, routingKey, type, outcome, durationMs });
    nr.incrementMetric(`Custom/Publish/${exchange}/${outcome}`);
    nr.recordMetric(`Custom/Publish/${exchange}/DurationMs`, durationMs);
  });
}

function startQueueDepthPoller(connection, queues) {
  if (!nr) return () => {};
  let channel = null;
  let warned = false;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      if (!channel) {
        channel = await connection.createChannel();
        channel.on('error', () => {});
        channel.on('close', () => { channel = null; });
      }
      for (const queue of queues) {
        const { messageCount, consumerCount } = await channel.checkQueue(queue);
        safe(() => {
          nr.recordCustomEvent('QueueDepth', { queue, messages: messageCount, consumers: consumerCount });
          nr.recordMetric(`Custom/Queue/${queue}/Depth`, messageCount);
          nr.recordMetric(`Custom/Queue/${queue}/Consumers`, consumerCount);
        });
      }
      warned = false;
    } catch (err) {
      channel = null;
      if (!warned) console.warn('[telemetry] No se pudo leer el largo de las colas:', err.message);
      warned = true;
    }
  }

  const timer = setInterval(tick, QUEUE_DEPTH_INTERVAL_MS);
  timer.unref();
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (channel) channel.close().catch(() => {});
    channel = null;
  };
}

module.exports = { enabled, consumer, recordMessage, recordBroker, recordPublish, startQueueDepthPoller };
