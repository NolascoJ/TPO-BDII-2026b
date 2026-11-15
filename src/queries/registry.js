import { q01 } from './q01.js';
import { q02 } from './q02.js';
import { q03 } from './q03.js';
import { q04 } from './q04.js';
import { q05 } from './q05.js';
import { q06 } from './q06.js';
import { q08 } from './q08.js';
import { q09 } from './q09.js';
import { q10 } from './q10.js';
import { q12 } from './q12.js';
import { q14 } from './q14.js';

/** Cada integrante registra aquí su función y los motores que necesita. */
export const queries = {
  q01: { run: q01, engines: ['mongo'] },
  q02: { run: q02, engines: ['mongo'] },
  q03: { run: q03, engines: ['neo4j'] },
  q04: { run: q04, engines: ['neo4j'] },
  q05: { run: q05, engines: ['neo4j'] },
  q06: { run: q06, engines: ['mongo'] },
  q08: { run: q08, engines: ['mongo'] },
  q09: { run: q09, engines: ['mongo'] },
  q10: { run: q10, engines: ['neo4j'] },
  q12: { run: q12, engines: ['neo4j'] },
  q14: { run: q14, engines: ['mongo'] },
};
