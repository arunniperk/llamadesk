// Guards the KV-cache math behind the "Max" context button. Getting this wrong means
// llama-server fails to allocate at start, so the per-layer-array and sliding-window cases
// (Gemma 4) matter as much as the simple scalar case.
//   node scripts/test-context-sizing.js
const path = require('path');
const models = require(path.join(__dirname, '..', 'src', 'main', 'models.js'));

let failed = 0;
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  → ' + extra : ''}`);
  if (!cond) failed++;
};
const KB = (b) => Math.round(b / 1024);

// ---- scalar head_count_kv (Llama/Qwen shape) ----
const llama = { blockCount: 32, headCount: 32, headCountKv: 8, keyLength: 128 };
// 2 (K+V) * 32 layers * 8 kv heads * 128 dim * 2 bytes = 131072
check('scalar GQA: bytes/token', models.kvBytesPerToken(llama) === 131072, KB(models.kvBytesPerToken(llama)) + ' KB');

// head_dim derived from embedding/head_count when key_length is absent
const derived = { blockCount: 32, headCount: 32, headCountKv: 8, embeddingLength: 4096 };
check('head_dim derived from embedding_length', models.kvBytesPerToken(derived) === 131072);

// ---- per-layer array head_count_kv (Gemma 4) ----
const gemmaNoSwa = { blockCount: 4, headCount: 16, headCountKv: [4, 4, 4, 4], keyLength: 512 };
// 2 * (4+4+4+4 = 16 heads) * 512 * 2 = 32768
check('per-layer array is summed, not multiplied', models.kvBytesPerToken(gemmaNoSwa) === 32768, KB(models.kvBytesPerToken(gemmaNoSwa)) + ' KB');

// ---- sliding-window layers must not count toward per-token growth ----
const gemmaSwa = { ...gemmaNoSwa, swaPattern: [1, 1, 1, 0] };
// only the single full-attention layer grows: 2 * 4 * 512 * 2 = 8192
check('sliding-window layers excluded', models.kvBytesPerToken(gemmaSwa) === 8192, KB(models.kvBytesPerToken(gemmaSwa)) + ' KB');
check('SWA model is cheaper per token than dense', models.kvBytesPerToken(gemmaSwa) < models.kvBytesPerToken(gemmaNoSwa));

// ---- missing shape info must yield 0, never NaN (NaN silently disabled the check before) ----
check('unknown shape returns 0', models.kvBytesPerToken({ blockCount: 32 }) === 0);
check('no block_count returns 0', models.kvBytesPerToken({ headCountKv: 8, keyLength: 128 }) === 0);
const nan = models.kvBytesPerToken({ blockCount: 4, headCountKv: [], keyLength: 512 });
check('empty per-layer array returns 0, not NaN', nan === 0, String(nan));

// ---- maxContextFor ----
const GB = 1024 ** 3;
const m = (sizeGB, perToken, trained) => ({ sizeBytes: sizeGB * GB, kvBytesPerToken: perToken, contextLength: trained });

const big = models.maxContextFor(m(13, 20 * 1024, 262144), 16);
check('13 GB SWA model on 16 GB gives a usable context', big > 40000 && big < 262144, big.toLocaleString());

const capped = models.maxContextFor(m(2, 20 * 1024, 8192), 16);
check('never exceeds the trained context', capped === 8192, String(capped));

const tooBig = models.maxContextFor(m(20, 128 * 1024, 128000), 16);
check('weights larger than VRAM yield 0', tooBig === 0, String(tooBig));

const unknown = models.maxContextFor(m(4, 0, 32768), 16);
check('unknown KV size falls back to trained context', unknown === 32768, String(unknown));

check('result is a whole number of tokens', Number.isInteger(big));

// ---- the headline claim: 10M tokens is not reachable ----
const need10M = 20 * 1024 * 10e6; // cheapest per-token cost we measured
check('10M tokens needs >100 GB even at 20 KB/token', need10M / GB > 100, Math.round(need10M / GB) + ' GB');

console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
