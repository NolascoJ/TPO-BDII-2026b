import { q01 } from './q01.js';
import { q02 } from './q02.js';
import { q08 } from './q08.js';

/** Cada integrante registra aquí su función y los motores que necesita. */
export const queries = {
  q01: { run: q01, engines: ['mongo'] },
  q02: { run: q02, engines: ['mongo'] },
  q08: { run: q08, engines: ['mongo'] },
};
