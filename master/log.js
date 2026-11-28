// Logs correlacionables (RNF01 de la E3).
//
// Toda línea que se escribe mientras se procesa un mensaje lleva el contexto de
// ese mensaje: cycleId, idpk, swapId, swapIdpk, offerId y tipo. No hace falta
// pasar esos campos a mano: el contexto viaja con AsyncLocalStorage por todo el
// procesamiento del mensaje, también por los `await`.
//
// - En stdout la línea sigue siendo legible y termina con el contexto:
//     [seller] swap-proposed handler error: ... | cycleId=c-1 idpk=... swapId=...
//   Si la línea ya es JSON (sagas/resume.js), el contexto va dentro del JSON y
//   los campos propios de la línea mandan.
// - Con el agente de New Relic cargado, cada línea también se envía a Logs como
//   un log con esos campos como atributos, enlazado a la transacción en curso.
//   Así, desde una alerta se busca por swapId y desde ahí se llega a la saga
//   (saga_runs.execution_name, o el executionName de los logs de las Lambdas).
//
// Los campos se llaman igual que en los logs de las Lambdas de la saga
// (infra/lambdas/*/shared.ts, logEvent), para poder buscarlos juntos.

const { AsyncLocalStorage } = require('node:async_hooks');
const util = require('node:util');

const storage = new AsyncLocalStorage();
const FIELDS = ['cycleId', 'idpk', 'msgId', 'type', 'swapId', 'swapIdpk', 'offerId', 'cityId', 'executionName'];
const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };

let newrelic = null;
let installed = false;

function clean(fields) {
  const out = {};
  for (const key of FIELDS) {
    const value = fields?.[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

// Campos de correlación de un mensaje de la mecánica (envelope v3).
function fieldsFromMessage(message) {
  if (!message || typeof message !== 'object') return {};
  const data = message.data && typeof message.data === 'object' ? message.data : {};
  const isWalletEvent = typeof message.type === 'string' && message.type.startsWith('swap-');
  return clean({
    cycleId: message.cycleId,
    idpk: message.idpk,
    msgId: message.msgId,
    type: message.type,
    cityId: message.cityId,
    swapId: data.swapId ?? message.swapId,
    // En los eventos de la wallet, data.idpk es la Idempotency-Key de nuestra operación.
    swapIdpk: isWalletEvent ? data.idpk : (data.swapIdpk ?? message.swapIdpk),
    offerId: data.offerId ?? message.offerId,
    executionName: message.executionName
  });
}

function context() {
  return storage.getStore() || {};
}

// Corre fn con más contexto (se suma al que ya hubiera).
function run(fields, fn) {
  return storage.run({ ...context(), ...clean(fields) }, fn);
}

// Agrega contexto al resto de la función async en curso.
function enter(fields) {
  storage.enterWith({ ...context(), ...clean(fields) });
}

function suffix(ctx) {
  const parts = Object.entries(ctx).map(([k, v]) => `${k}=${v}`);
  return parts.length ? ` | ${parts.join(' ')}` : '';
}

// Algunos módulos (p. ej. sagas/resume.js) ya loguean una línea JSON. Esa línea
// se mantiene como JSON válido: el contexto se agrega adentro, sin pisar sus campos.
function parseJsonLine(message) {
  const text = message.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Campos simples de la línea JSON, para enviarlos como atributos.
function scalars(json) {
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'message') continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

function forward(level, message, ctx, component, json) {
  if (!newrelic || typeof newrelic.recordLogEvent !== 'function') return;
  try {
    const scope = /^\[([\w-]+)\]/.exec(message)?.[1];
    const fromJson = json ? scalars(json) : {};
    if (typeof fromJson.level === 'string') fromJson.level = fromJson.level.toUpperCase();
    newrelic.recordLogEvent({
      message,
      level,
      component,
      ...(scope ? { scope } : {}),
      ...ctx,
      ...fromJson
    });
  } catch {
    // Un log que no se pudo enviar nunca interrumpe al nodo.
  }
}

// Reemplaza console.log/info/warn/error. Se llama una sola vez, al arrancar.
function install({ component, target = console, agent } = {}) {
  if (installed && target === console) return;
  if (agent !== undefined) {
    newrelic = agent;
  } else if (process.env.NEW_RELIC_LICENSE_KEY) {
    try { newrelic = require('newrelic'); } catch { newrelic = null; }
  }
  for (const method of Object.keys(LEVELS)) {
    const original = target[method].bind(target);
    target[method] = (...args) => {
      const ctx = context();
      const message = util.format(...args);
      const json = parseJsonLine(message);
      original(json ? JSON.stringify({ ...ctx, ...json }) : message + suffix(ctx));
      forward(LEVELS[method], message, ctx, component, json);
    };
  }
  if (target === console) installed = true;
}

// Middleware de Express: cada request a /events, /market o /internal/sagas
// corre con el contexto del mensaje que trae.
function middleware(req, res, next) {
  const fields = fieldsFromMessage(req.body);
  const saga = /^\/internal\/sagas\/([^/]+)/.exec(req.path);
  if (saga) {
    // El :idpk de la ruta es el idpk del mensaje que inició la saga = nombre de la ejecución.
    const name = decodeURIComponent(saga[1]);
    fields.idpk = fields.idpk || name;
    fields.executionName = fields.executionName || name;
  }
  run(fields, next);
}

module.exports = { install, run, enter, context, fieldsFromMessage, middleware, FIELDS };
