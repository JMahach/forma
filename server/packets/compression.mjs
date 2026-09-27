import { promisify } from 'node:util';
import { brotliCompress, gzip, constants } from 'node:zlib';

const brotli = promisify(brotliCompress), compressGzip = promisify(gzip);
const brOptions = quality => ({ params: { [constants.BROTLI_PARAM_QUALITY]: quality } });

// Both formats preserve float64 exactly. Compare the same five reversible
// predictors cheaply; final compression is done only once per representation.
export async function encodePredictedDay(day, encodeColumn, encodePacket) {
  const orders = [];
  for (const column of day.columns) {
    const scores = await Promise.all([0, 1, 2, 3, 4].map(async order => ({
      order, bytes: (await brotli(encodeColumn(column, order), brOptions(4))).length,
    })));
    orders.push(scores.reduce((best, score) => score.bytes < best.bytes ? score : best).order);
  }
  return Buffer.from(encodePacket(day, { orders }));
}

export async function compressDayPacket(raw, { quality = 11, storedGzip } = {}) {
  const [br, gz] = await Promise.all([brotli(raw, brOptions(quality)), storedGzip || compressGzip(raw, { level: 9 })]);
  return { identity: raw, br, gzip: gz };
}
