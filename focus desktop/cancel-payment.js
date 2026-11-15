const { randomBytes } = require("node:crypto");
const { join } = require("node:path");

const RECIPIENT = "7L7hiJuiaSUiSpUHccMHAotGrBcUr22VYj7897XiQv41";
const FEE_FACTOR = 0.4;
const USD_RATE = 0.20;
const LAMPORTS = 1e9;
let quote;

function rpcUrl() {
  if (!process.env.SOLANA_RPC_URL) process.loadEnvFile(join(__dirname, ".env"));
  return process.env.SOLANA_RPC_URL;
}

async function createQuote(sessionId, seconds) {
  rpcUrl();
  const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Price unavailable");
  const price = (await response.json()).solana?.usd;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Price unavailable");
  const usd = Math.max(.01, Math.round(seconds / 60 * FEE_FACTOR * USD_RATE * 100) / 100);
  const lamports = Math.ceil(usd / price * LAMPORTS);
  const reference = randomBytes(24).toString("hex");
  const sol = (lamports / LAMPORTS).toFixed(9);
  quote = { sessionId, lamports, reference };
  return { usd: usd.toFixed(2), sol, recipient: RECIPIENT, reference };
}

async function verifyPayment(sessionId, wallet, signature) {
  const expected = quote;
  if (!expected || expected.sessionId !== sessionId ||
      typeof wallet !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) ||
      typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) return false;
  const response = await fetch(rpcUrl(), {
    method: "POST", headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, {
      encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0,
    }] }),
  });
  if (!response.ok) throw new Error("RPC unavailable");
  const result = (await response.json()).result;
  const message = result?.transaction?.message;
  if (!result?.meta || result.meta.err !== null || !message) return false;
  const instructions = message.instructions;
  const transfer = instructions.some(i => i.program === "system" && i.parsed?.type === "transfer" &&
    i.parsed.info.source === wallet && message.accountKeys.some(key => key.pubkey === wallet && key.signer) && i.parsed.info.destination === RECIPIENT &&
    i.parsed.info.lamports === expected.lamports);
  const memo = instructions.some(i => i.program === "spl-memo" && i.parsed === expected.reference);
  if (!transfer || !memo || quote !== expected) return false;
  quote = undefined;
  return true;
}

module.exports = { createQuote, verifyPayment };
