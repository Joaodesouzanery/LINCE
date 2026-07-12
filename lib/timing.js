// Comparacao de string em tempo (quase) constante para SEGREDOS (Bearer/CRON).
// Evita o oracle de timing char-a-char do `===` do V8. O comprimento ainda
// "vaza" (retorna cedo se tamanhos diferem), mas isso e o mesmo trade-off das
// libs safe-compare e nao e exploravel na pratica sobre rede.
const crypto = require("crypto");

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { timingSafeEqualStr };
