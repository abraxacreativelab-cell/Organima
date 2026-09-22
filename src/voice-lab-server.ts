/**
 * Arranque del laboratorio conversacional A/B.
 *
 * Se ejecuta desde la raíz del checkout, con las variables del `.env` del proyecto principal
 * (el lanzador pasa `DOTENV_CONFIG_PATH`; este archivo no lee ni imprime secretos):
 *
 *   npx tsx src/voice-lab-server.ts
 *
 * Reglas de este archivo:
 * - Carga `dotenv/config` (respeta `DOTENV_CONFIG_PATH`).
 * - Escucha SÓLO en `127.0.0.1`, en `VOICE_LAB_PORT` (3212 por defecto).
 * - Sirve la página del laboratorio en `/` y sus archivos estáticos desde `public/`.
 * - Ante SIGINT/SIGTERM cierra el laboratorio (cancela pendientes) y el servidor.
 */
import 'dotenv/config';
import express from 'express';
import { resolve } from 'node:path';
import { createVoiceLab } from './voice-lab.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3212;

/** Puerto explícito y validado: un valor inválido detiene el arranque en vez de caer a otro. */
function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('VOICE_LAB_PORT inválido: se esperaba un entero entre 1 y 65535.');
  }
  return parsed;
}

const port = resolvePort(process.env.VOICE_LAB_PORT);
const lab = createVoiceLab({ env: process.env });

const app = express();
app.use(lab.app);
app.use(
  express.static(resolve(process.cwd(), 'public'), {
    index: 'voice-lab.html',
    fallthrough: true,
  }),
);

const server = app.listen(port, HOST, () => {
  console.log(`Laboratorio de voz: http://${HOST}:${port}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`No se pudo abrir el laboratorio en ${HOST}:${port}: ${error.code ?? error.message}`);
  lab.close();
  process.exitCode = 1;
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`${signal}: cerrando el laboratorio.`);
  lab.close();
  server.close(() => process.exit(0));
  // Sin fugas: si el cierre no termina en dos segundos, se sale de todos modos.
  setTimeout(() => process.exit(0), 2000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => shutdown(signal));
}
